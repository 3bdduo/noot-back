import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { SETTING_DEFS, SETTING_KEYS, defaultFor, isSettingKey } from './settings.registry.js';
import type { SettingKey, SettingValue } from './settings.registry.js';

const CACHE_MS = 30_000;

@Injectable()
export class SettingsService {
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(private readonly prisma: PrismaService) {}

  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as SettingValue<K>;

    const row = await this.prisma.setting.findUnique({ where: { key } });
    const parsed = SETTING_DEFS[key].schema.safeParse(row?.value ?? {});
    const value = (parsed.success ? parsed.data : defaultFor(key)) as SettingValue<K>;
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  async set(key: string, input: unknown): Promise<unknown> {
    if (!isSettingKey(key)) throw AppError.badRequest('SETTING_UNKNOWN');
    const value = SETTING_DEFS[key].schema.parse(input);
    await this.prisma.setting.upsert({
      where: { key },
      create: { key, value: value as Prisma.InputJsonValue },
      update: { value: value as Prisma.InputJsonValue },
    });
    this.cache.delete(key);
    return value;
  }

  async all(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const key of SETTING_KEYS) out[key] = await this.get(key);
    return out;
  }

  /** Storefront-safe subset (no internal knobs). */
  async publicSettings() {
    const [store, cod, tax, checkout] = await Promise.all([
      this.get('store'),
      this.get('cod'),
      this.get('tax'),
      this.get('checkout'),
    ]);
    return {
      currency: 'EGP',
      store,
      cod: { enabled: cod.enabled, fee: cod.fee, maxOrderTotal: cod.maxOrderTotal },
      tax: { enabled: tax.enabled, rateBps: tax.rateBps, inclusive: tax.inclusive, label: tax.label },
      checkout: { guestCheckout: checkout.guestCheckout },
    };
  }
}
