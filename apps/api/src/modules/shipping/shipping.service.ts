import { Injectable } from '@nestjs/common';
import { GOVERNORATES, isGovernorateCode } from '@nb/shared';
import type { Locale } from '@nb/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Db, Tx } from '../../prisma/prisma.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { shippingFeeFor } from '../pricing/pricing.js';
import { CarrierRegistry } from './carrier.js';

export interface ResolvedShipping {
  zoneId: string;
  rateId: string;
  rateName: string;
  fee: number;
  codAvailable: boolean;
  estimatedDaysMin: number;
  estimatedDaysMax: number;
  freeOverSubtotal: number | null;
}

@Injectable()
export class ShippingService {
  readonly carriers = new CarrierRegistry();

  constructor(private readonly prisma: PrismaService) {}

  /** Finds the cheapest active rate for a governorate. `amount` = subtotal after discounts. */
  async resolve(governorate: string, amount: number, db: Db = this.prisma): Promise<ResolvedShipping> {
    if (!isGovernorateCode(governorate)) throw AppError.badRequest('SHIPPING_NOT_AVAILABLE');
    const link = await db.shippingZoneGovernorate.findUnique({
      where: { governorate },
      include: { zone: { include: { rates: { where: { active: true }, orderBy: { baseFee: 'asc' } } } } },
    });
    if (!link || !link.zone.active || link.zone.rates.length === 0) throw AppError.unprocessable('SHIPPING_NOT_AVAILABLE');

    const rate = link.zone.rates[0];
    return {
      zoneId: link.zone.id,
      rateId: rate.id,
      rateName: rate.name,
      fee: shippingFeeFor(rate, amount),
      codAvailable: rate.codAvailable,
      estimatedDaysMin: link.zone.estimatedDaysMin,
      estimatedDaysMax: link.zone.estimatedDaysMax,
      freeOverSubtotal: rate.freeOverSubtotal,
    };
  }

  async quote(governorate: string, amount: number) {
    const r = await this.resolve(governorate, amount);
    return {
      governorate,
      fee: r.fee,
      rateName: r.rateName,
      codAvailable: r.codAvailable,
      estimatedDaysMin: r.estimatedDaysMin,
      estimatedDaysMax: r.estimatedDaysMax,
      freeOverSubtotal: r.freeOverSubtotal,
      remainingForFreeShipping: r.freeOverSubtotal !== null && amount < r.freeOverSubtotal ? r.freeOverSubtotal - amount : 0,
    };
  }

  /** Dropdown data for checkout: every governorate and whether we deliver there. */
  async governorates(locale: Locale) {
    const links = await this.prisma.shippingZoneGovernorate.findMany({
      include: { zone: { include: { rates: { where: { active: true }, orderBy: { baseFee: 'asc' }, take: 1 } } } },
    });
    const byCode = new Map(links.map((l) => [l.governorate, l]));
    return GOVERNORATES.map((g) => {
      const link = byCode.get(g.code);
      const rate = link?.zone.active ? link.zone.rates[0] : undefined;
      return {
        code: g.code,
        name: locale === 'ar' ? g.nameAr : g.nameEn,
        available: Boolean(rate),
        codAvailable: Boolean(rate?.codAvailable),
        fee: rate?.baseFee ?? null,
        estimatedDaysMin: link?.zone.estimatedDaysMin ?? null,
        estimatedDaysMax: link?.zone.estimatedDaysMax ?? null,
      };
    });
  }

  // ---------------------------------------------------------------- admin: zones & rates

  listZones() {
    return this.prisma.shippingZone.findMany({
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { governorates: true, rates: { orderBy: { baseFee: 'asc' } } },
    });
  }

  createZone(input: { nameAr: string; nameEn: string; estimatedDaysMin?: number; estimatedDaysMax?: number; active?: boolean; sortOrder?: number }) {
    this.assertDays(input.estimatedDaysMin, input.estimatedDaysMax);
    return this.prisma.shippingZone.create({ data: input, include: { governorates: true, rates: true } });
  }

  async updateZone(id: string, input: { nameAr?: string; nameEn?: string; estimatedDaysMin?: number; estimatedDaysMax?: number; active?: boolean; sortOrder?: number }) {
    const zone = await this.prisma.shippingZone.findUnique({ where: { id } });
    if (!zone) throw AppError.notFound();
    this.assertDays(input.estimatedDaysMin ?? zone.estimatedDaysMin, input.estimatedDaysMax ?? zone.estimatedDaysMax);
    return this.prisma.shippingZone.update({ where: { id }, data: input, include: { governorates: true, rates: true } });
  }

  async deleteZone(id: string) {
    const zone = await this.prisma.shippingZone.findUnique({ where: { id }, select: { id: true } });
    if (!zone) throw AppError.notFound();
    await this.prisma.shippingZone.delete({ where: { id } });
    return { ok: true };
  }

  /** A governorate belongs to exactly one zone: assigning it here moves it away from any other zone. */
  async setZoneGovernorates(zoneId: string, codes: string[]) {
    const zone = await this.prisma.shippingZone.findUnique({ where: { id: zoneId }, select: { id: true } });
    if (!zone) throw AppError.notFound();
    const unique = [...new Set(codes)];
    if (unique.some((c) => !isGovernorateCode(c))) throw AppError.badRequest('VALIDATION_ERROR', {}, [{ field: 'codes', code: 'INVALID_GOVERNORATE' }]);

    await this.prisma.$transaction(async (tx) => {
      await tx.shippingZoneGovernorate.deleteMany({ where: { zoneId } });
      for (const governorate of unique) {
        await tx.shippingZoneGovernorate.upsert({ where: { governorate }, create: { governorate, zoneId }, update: { zoneId } });
      }
    });
    return this.listZones();
  }

  async createRate(zoneId: string, input: { name: string; baseFee: number; freeOverSubtotal?: number | null; codAvailable?: boolean; active?: boolean }) {
    const zone = await this.prisma.shippingZone.findUnique({ where: { id: zoneId }, select: { id: true } });
    if (!zone) throw AppError.notFound();
    return this.prisma.shippingRate.create({ data: { ...input, zoneId } });
  }

  async updateRate(id: string, input: { name?: string; baseFee?: number; freeOverSubtotal?: number | null; codAvailable?: boolean; active?: boolean }) {
    const rate = await this.prisma.shippingRate.findUnique({ where: { id }, select: { id: true } });
    if (!rate) throw AppError.notFound();
    return this.prisma.shippingRate.update({ where: { id }, data: input });
  }

  async deleteRate(id: string) {
    const rate = await this.prisma.shippingRate.findUnique({ where: { id }, select: { id: true } });
    if (!rate) throw AppError.notFound();
    await this.prisma.shippingRate.delete({ where: { id } });
    return { ok: true };
  }

  private assertDays(min?: number, max?: number) {
    if (min !== undefined && max !== undefined && min > max) {
      throw AppError.badRequest('VALIDATION_ERROR', {}, [{ field: 'estimatedDaysMin', code: 'INVALID_RULE' }]);
    }
  }

  // ---------------------------------------------------------------- shipments (called by OrdersService inside its transaction)

  async createShipment(
    tx: Tx,
    input: {
      orderId: string;
      carrier: string;
      trackingNumber?: string | null;
      trackingUrl?: string | null;
      estimatedDeliveryAt?: Date | null;
      items: Array<{ orderItemId: string; quantity: number }>;
    },
  ) {
    const carrier = this.carriers.get(input.carrier);
    const trackingUrl = input.trackingUrl ?? (input.trackingNumber ? carrier.buildTrackingUrl(input.trackingNumber) : null);
    const shipment = await tx.shipment.create({
      data: {
        orderId: input.orderId,
        carrier: input.carrier,
        trackingNumber: input.trackingNumber ?? null,
        trackingUrl,
        status: 'IN_TRANSIT',
        shippedAt: new Date(),
        estimatedDeliveryAt: input.estimatedDeliveryAt ?? null,
        items: { create: input.items.map((i) => ({ orderItemId: i.orderItemId, quantity: i.quantity })) },
        events: { create: { status: 'IN_TRANSIT', description: 'Shipment created', source: 'admin' } },
      },
    });
    return shipment;
  }
}
