import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { CustomizationInput, Locale } from '@nb/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Db } from '../../prisma/prisma.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { pickTranslation } from '../../common/utils/translate.js';
import type { Actor } from '../../common/types.js';
import { evaluateCustomization } from './customization.engine.js';
import type { EvaluationResult, FileInfo, GroupDef, LocalizedName, OptionDef } from './customization.engine.js';
import type { CreateGroupInput, CreateOptionInput, UpdateGroupInput, UpdateOptionInput } from './customization.schemas.js';

const GROUP_INCLUDE = {
  translations: true,
  options: {
    where: { deletedAt: null },
    orderBy: { sortOrder: 'asc' },
    include: { translations: true, inventory: true },
  },
} satisfies Prisma.CustomizationGroupInclude;

type GroupRow = Prisma.CustomizationGroupGetPayload<{ include: typeof GROUP_INCLUDE }>;

function localizedName(translations: Array<{ locale: string; name: string }>, fallback: string): LocalizedName {
  const ar = translations.find((t) => t.locale === 'ar')?.name;
  const en = translations.find((t) => t.locale === 'en')?.name;
  return { ar: ar ?? en ?? fallback, en: en ?? ar ?? fallback };
}

export function toGroupDef(group: GroupRow, requiredOverride?: boolean | null): GroupDef {
  return {
    id: group.id,
    code: group.code,
    stepKey: group.stepKey,
    type: group.type,
    required: requiredOverride ?? group.required,
    exclusiveWithinStep: group.exclusiveWithinStep,
    minSelect: group.minSelect,
    maxSelect: group.maxSelect,
    minLength: group.minLength,
    maxLength: group.maxLength,
    allowedCharsets: group.allowedCharsets,
    pattern: group.pattern,
    allowedMimeTypes: group.allowedMimeTypes,
    maxFileSizeBytes: group.maxFileSizeBytes,
    minWidthPx: group.minWidthPx,
    minHeightPx: group.minHeightPx,
    maxWidthPx: group.maxWidthPx,
    maxHeightPx: group.maxHeightPx,
    priceDelta: group.priceDelta,
    active: group.active && !group.deletedAt,
    name: localizedName(group.translations, group.code),
    options: group.options.map(
      (o): OptionDef => ({
        id: o.id,
        code: o.code,
        priceDelta: o.priceDelta,
        active: o.active && !o.deletedAt,
        isDefault: o.isDefault,
        name: localizedName(o.translations, o.code),
      }),
    ),
  };
}

@Injectable()
export class CustomizationService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------- engine entry points

  /** Group definitions that apply to a product (product-level `required` override applied). */
  async loadGroups(productId: string, db: Db = this.prisma): Promise<GroupDef[]> {
    const links = await db.productCustomization.findMany({
      where: { productId, group: { active: true, deletedAt: null } },
      orderBy: { sortOrder: 'asc' },
      include: { group: { include: GROUP_INCLUDE } },
    });
    return links.map((l) => toGroupDef(l.group, l.required));
  }

  async loadFiles(ids: string[], actor: Actor, db: Db = this.prisma): Promise<Map<string, FileInfo>> {
    const map = new Map<string, FileInfo>();
    if (ids.length === 0) return map;
    const rows = await db.artworkFile.findMany({ where: { id: { in: ids } } });
    for (const r of rows) {
      map.set(r.id, {
        id: r.id,
        status: r.status,
        groupId: r.groupId,
        mimeType: r.mimeType,
        sizeBytes: r.sizeBytes,
        widthPx: r.widthPx,
        heightPx: r.heightPx,
        ownedByActor: Boolean((actor.userId && r.userId === actor.userId) || (actor.guestHash && r.guestToken === actor.guestHash)),
      });
    }
    return map;
  }

  /** Loads definitions + files for the product and runs the pure engine. Never throws for invalid input. */
  async evaluate(
    productId: string,
    input: CustomizationInput | undefined | null,
    actor: Actor,
    db: Db = this.prisma,
  ): Promise<{ groups: GroupDef[]; result: EvaluationResult }> {
    const groups = await this.loadGroups(productId, db);
    const fileIds = (input ?? []).map((i) => i.artworkFileId).filter((x): x is string => Boolean(x));
    const files = await this.loadFiles(fileIds, actor, db);
    return { groups, result: evaluateCustomization(groups, input, files) };
  }

  assertValid(result: EvaluationResult): void {
    if (!result.ok) throw AppError.unprocessable('CUSTOMIZATION_INVALID', {}, result.issues);
  }

  // ---------------------------------------------------------------- public customizer config

  async publicConfig(productId: string, locale: Locale) {
    const links = await this.prisma.productCustomization.findMany({
      where: { productId, group: { active: true, deletedAt: null } },
      orderBy: { sortOrder: 'asc' },
      include: { group: { include: GROUP_INCLUDE } },
    });

    const steps = new Map<string, any[]>();
    for (const link of links) {
      const g = link.group;
      const tr = pickTranslation(g.translations, locale);
      const item = {
        code: g.code,
        stepKey: g.stepKey,
        type: g.type,
        required: link.required ?? g.required,
        exclusiveWithinStep: g.exclusiveWithinStep,
        name: tr?.name ?? g.code,
        description: tr?.description ?? null,
        placeholder: tr?.placeholder ?? null,
        helpText: tr?.helpText ?? null,
        rules: {
          minSelect: g.minSelect,
          maxSelect: g.maxSelect,
          minLength: g.minLength,
          maxLength: g.maxLength,
          allowedCharsets: g.allowedCharsets,
          pattern: g.pattern,
          allowedMimeTypes: g.allowedMimeTypes,
          maxFileSizeBytes: g.maxFileSizeBytes,
          minWidthPx: g.minWidthPx,
          minHeightPx: g.minHeightPx,
          maxWidthPx: g.maxWidthPx,
          maxHeightPx: g.maxHeightPx,
        },
        priceDelta: g.priceDelta,
        options: g.options
          .filter((o) => o.active)
          .map((o) => {
            const otr = pickTranslation(o.translations, locale);
            const inv = o.inventory;
            const available = !inv || !inv.trackInventory || inv.allowBackorder || inv.quantity - inv.reserved > 0;
            return {
              code: o.code,
              name: otr?.name ?? o.code,
              description: otr?.description ?? null,
              imageUrl: o.imageUrl,
              previewLayerUrl: o.previewLayerUrl,
              colorHex: o.colorHex,
              priceDelta: o.priceDelta,
              isDefault: o.isDefault,
              available,
            };
          }),
      };
      const list = steps.get(g.stepKey) ?? [];
      list.push(item);
      steps.set(g.stepKey, list);
    }
    return { steps: [...steps.entries()].map(([stepKey, groups]) => ({ stepKey, groups })) };
  }

  // ---------------------------------------------------------------- admin: groups

  async listGroups(query: { stepKey?: string; search?: string; includeInactive?: boolean }) {
    const rows = await this.prisma.customizationGroup.findMany({
      where: {
        deletedAt: null,
        active: query.includeInactive ? undefined : true,
        stepKey: query.stepKey,
        ...(query.search
          ? { OR: [{ code: { contains: query.search, mode: 'insensitive' } }, { translations: { some: { name: { contains: query.search, mode: 'insensitive' } } } }] }
          : {}),
      },
      orderBy: [{ stepKey: 'asc' }, { sortOrder: 'asc' }],
      include: { ...GROUP_INCLUDE, _count: { select: { products: true } } },
    });
    return rows;
  }

  async getGroup(id: string) {
    const row = await this.prisma.customizationGroup.findFirst({
      where: { id, deletedAt: null },
      include: { ...GROUP_INCLUDE, _count: { select: { products: true } } },
    });
    if (!row) throw AppError.notFound();
    return row;
  }

  async createGroup(input: CreateGroupInput) {
    this.assertGroupRules(input);
    const { translations, ...data } = input;
    const created = await this.prisma.customizationGroup.create({
      data: { ...data, translations: { create: translations } },
      select: { id: true },
    });
    return this.getGroup(created.id);
  }

  async updateGroup(id: string, input: UpdateGroupInput) {
    const existing = await this.getGroup(id);
    this.assertGroupRules({ ...existing, ...input } as any);
    const { translations, ...data } = input;
    await this.prisma.$transaction(async (tx) => {
      await tx.customizationGroup.update({ where: { id }, data });
      if (translations) {
        for (const t of translations) {
          await tx.customizationGroupTranslation.upsert({
            where: { groupId_locale: { groupId: id, locale: t.locale } },
            create: { groupId: id, ...t },
            update: t,
          });
        }
      }
    });
    return this.getGroup(id);
  }

  /** Soft delete: past orders keep their snapshots; the group disappears from the customizer. */
  async deleteGroup(id: string) {
    await this.getGroup(id);
    await this.prisma.customizationGroup.update({ where: { id }, data: { deletedAt: new Date(), active: false } });
    return { ok: true };
  }

  private assertGroupRules(g: Partial<CreateGroupInput> & { type?: string }) {
    const bad = (field: string) => AppError.badRequest('VALIDATION_ERROR', {}, [{ field, code: 'INVALID_RULE' }]);
    if (g.minLength != null && g.maxLength != null && g.minLength > g.maxLength) throw bad('minLength');
    if (g.maxSelect != null && g.minSelect != null && g.minSelect > g.maxSelect) throw bad('minSelect');
    if (g.minWidthPx != null && g.maxWidthPx != null && g.minWidthPx > g.maxWidthPx) throw bad('minWidthPx');
    if (g.minHeightPx != null && g.maxHeightPx != null && g.minHeightPx > g.maxHeightPx) throw bad('minHeightPx');
    if (g.pattern) {
      try {
        new RegExp(g.pattern, 'u');
      } catch {
        throw bad('pattern');
      }
    }
  }

  // ---------------------------------------------------------------- admin: options

  async createOption(groupId: string, input: CreateOptionInput) {
    await this.getGroup(groupId);
    const { translations, stock, ...data } = input;
    const optionId = await this.prisma.$transaction(async (tx) => {
      if (data.isDefault) await tx.customizationOption.updateMany({ where: { groupId, isDefault: true }, data: { isDefault: false } });
      const option = await tx.customizationOption.create({
        data: { ...data, groupId, translations: { create: translations } },
        select: { id: true },
      });
      if (stock) {
        await tx.inventoryItem.create({ data: { optionId: option.id, sku: data.sku ?? null, ...stock } });
      }
      return option.id;
    });
    return this.getOption(optionId);
  }

  async getOption(id: string) {
    const row = await this.prisma.customizationOption.findFirst({
      where: { id, deletedAt: null },
      include: { translations: true, inventory: true },
    });
    if (!row) throw AppError.notFound();
    return row;
  }

  async updateOption(id: string, input: UpdateOptionInput) {
    const existing = await this.getOption(id);
    const { translations, ...data } = input;
    await this.prisma.$transaction(async (tx) => {
      if (data.isDefault) await tx.customizationOption.updateMany({ where: { groupId: existing.groupId, isDefault: true, id: { not: id } }, data: { isDefault: false } });
      await tx.customizationOption.update({ where: { id }, data });
      if (translations) {
        for (const t of translations) {
          await tx.customizationOptionTranslation.upsert({
            where: { optionId_locale: { optionId: id, locale: t.locale } },
            create: { optionId: id, ...t },
            update: t,
          });
        }
      }
    });
    return this.getOption(id);
  }

  async deleteOption(id: string) {
    await this.getOption(id);
    await this.prisma.customizationOption.update({ where: { id }, data: { deletedAt: new Date(), active: false, sku: null } });
    return { ok: true };
  }

  // ---------------------------------------------------------------- admin: product links

  async setProductGroups(productId: string, links: Array<{ groupId: string; required?: boolean | null; sortOrder?: number }>) {
    const product = await this.prisma.product.findFirst({ where: { id: productId, deletedAt: null }, select: { id: true } });
    if (!product) throw AppError.notFound('PRODUCT_NOT_FOUND');
    const ids = [...new Set(links.map((l) => l.groupId))];
    const groups = await this.prisma.customizationGroup.count({ where: { id: { in: ids }, deletedAt: null } });
    if (groups !== ids.length) throw AppError.notFound();

    await this.prisma.$transaction(async (tx) => {
      await tx.productCustomization.deleteMany({ where: { productId } });
      if (links.length) {
        await tx.productCustomization.createMany({
          data: links.map((l) => ({ productId, groupId: l.groupId, required: l.required ?? null, sortOrder: l.sortOrder ?? 0 })),
        });
      }
      await tx.product.update({ where: { id: productId }, data: { isCustomizable: links.length > 0 } });
    });
    return { ok: true, count: links.length };
  }

  async getProductGroups(productId: string) {
    return this.prisma.productCustomization.findMany({
      where: { productId },
      orderBy: { sortOrder: 'asc' },
      include: { group: { include: { translations: true } } },
    });
  }
}
