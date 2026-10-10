import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Locale } from '@nb/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { hmacHex, safeEqual } from '../../common/crypto/tokens.js';
import { skipTake, toPage } from '../../common/utils/pagination.js';
import type { Pagination } from '../../common/utils/pagination.js';
import { sanitizeRichText } from '../../common/utils/sanitize.js';
import { pickTranslation } from '../../common/utils/translate.js';
import { env } from '../../config/env.js';
import { CARD_INCLUDE, CatalogService } from '../catalog/catalog.service.js';

/** Content kinds that share the same "entity + translations" shape. */
export const CONTENT_KINDS = ['banners', 'testimonials', 'faq', 'pages', 'journal', 'homepage', 'instagram'] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];

interface KindConfig {
  model: string;
  trModel?: string;
  fk?: string;
  orderBy: unknown;
  /** Translation fields that hold rich text and are sanitised on write. */
  richFields?: string[];
}

const KINDS: Record<ContentKind, KindConfig> = {
  banners: { model: 'banner', trModel: 'bannerTranslation', fk: 'bannerId', orderBy: [{ placement: 'asc' }, { sortOrder: 'asc' }] },
  testimonials: { model: 'testimonial', trModel: 'testimonialTranslation', fk: 'testimonialId', orderBy: { sortOrder: 'asc' } },
  faq: { model: 'faqItem', trModel: 'faqItemTranslation', fk: 'faqId', orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }], richFields: ['answer'] },
  pages: { model: 'page', trModel: 'pageTranslation', fk: 'pageId', orderBy: { key: 'asc' }, richFields: ['content'] },
  journal: { model: 'journalPost', trModel: 'journalPostTranslation', fk: 'postId', orderBy: { createdAt: 'desc' }, richFields: ['content'] },
  homepage: { model: 'homepageSection', trModel: 'homepageSectionTranslation', fk: 'sectionId', orderBy: { sortOrder: 'asc' } },
  instagram: { model: 'instagramPost', orderBy: { sortOrder: 'asc' } },
};

export const newsletterToken = (email: string) => hmacHex(env.AUTH_SECRET, `newsletter:${email.toLowerCase()}`);

const publicUrl = (path: string) => `${env.APP_URL.replace(/\/$/, '')}${path}`;

type Translation = { locale: string; [k: string]: unknown };

@Injectable()
export class ContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
  ) {}

  // ================================================================ public

  async homepage(locale: Locale) {
    const sections = await this.prisma.homepageSection.findMany({
      where: { active: true },
      orderBy: { sortOrder: 'asc' },
      include: {
        translations: true,
        products: { orderBy: { sortOrder: 'asc' }, include: { product: { include: CARD_INCLUDE } } },
        collections: { orderBy: { sortOrder: 'asc' }, include: { collection: { include: { translations: true } } } },
      },
    });

    const out: Record<string, unknown>[] = [];
    for (const s of sections) {
      const tr = pickTranslation(s.translations, locale);
      const base = {
        id: s.id,
        type: s.type,
        title: tr?.title ?? null,
        subtitle: tr?.subtitle ?? null,
        body: tr?.body ?? null,
        ctaLabel: tr?.ctaLabel ?? null,
        imageUrl: s.imageUrl,
        linkUrl: s.linkUrl,
      } as Record<string, unknown>;

      if (s.type === 'FEATURED_PRODUCTS' || s.type === 'GIFTS') {
        let rows = s.products.map((p) => p.product).filter((p) => p.status === 'ACTIVE' && !p.deletedAt);
        if (rows.length === 0) {
          rows = await this.prisma.product.findMany({
            where: { status: 'ACTIVE', deletedAt: null, ...(s.type === 'GIFTS' ? { isGift: true } : { featured: true }) },
            orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
            take: 8,
            include: CARD_INCLUDE,
          });
        }
        base.products = rows.map((r) => this.catalog.toCard(r, locale));
      }
      if (s.type === 'COLLECTIONS') {
        base.collections = s.collections
          .filter((c) => c.collection.active && !c.collection.deletedAt)
          .map((c) => {
            const ctr = pickTranslation(c.collection.translations, locale);
            return { id: c.collection.id, slug: c.collection.slug, imageUrl: c.collection.imageUrl, name: ctr?.name ?? c.collection.slug, description: ctr?.description ?? null };
          });
      }
      if (s.type === 'TESTIMONIALS') base.testimonials = await this.testimonials(locale);
      if (s.type === 'INSTAGRAM') base.posts = await this.instagram();
      out.push(base);
    }
    return { sections: out };
  }

  async banners(locale: Locale, placement?: string) {
    const now = new Date();
    const rows = await this.prisma.banner.findMany({
      where: {
        active: true,
        placement,
        AND: [{ OR: [{ startsAt: null }, { startsAt: { lte: now } }] }, { OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
      },
      orderBy: [{ placement: 'asc' }, { sortOrder: 'asc' }],
      include: { translations: true },
    });
    return rows.map((b) => {
      const tr = pickTranslation(b.translations, locale);
      return { id: b.id, placement: b.placement, imageUrl: b.imageUrl, mobileImageUrl: b.mobileImageUrl, linkUrl: b.linkUrl, title: tr?.title ?? null, subtitle: tr?.subtitle ?? null, ctaLabel: tr?.ctaLabel ?? null };
    });
  }

  async testimonials(locale: Locale) {
    const rows = await this.prisma.testimonial.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' }, include: { translations: true } });
    return rows.map((t) => {
      const tr = pickTranslation(t.translations, locale);
      return { id: t.id, authorName: t.authorName, avatarUrl: t.avatarUrl, rating: t.rating, quote: tr?.quote ?? '', authorTitle: tr?.authorTitle ?? null };
    });
  }

  async faq(locale: Locale, category?: string) {
    const rows = await this.prisma.faqItem.findMany({ where: { active: true, category }, orderBy: [{ category: 'asc' }, { sortOrder: 'asc' }], include: { translations: true } });
    return rows.map((f) => {
      const tr = pickTranslation(f.translations, locale);
      return { id: f.id, category: f.category, question: tr?.question ?? '', answer: tr?.answer ?? '' };
    });
  }

  instagram() {
    return this.prisma.instagramPost.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' }, select: { id: true, imageUrl: true, linkUrl: true, caption: true } });
  }

  async page(key: string, locale: Locale) {
    const page = await this.prisma.page.findFirst({ where: { key, active: true }, include: { translations: true } });
    if (!page) throw AppError.notFound();
    const tr = pickTranslation(page.translations, locale);
    return {
      key: page.key,
      title: tr?.title ?? page.key,
      content: tr?.content ?? '',
      updatedAt: page.updatedAt,
      seo: { title: tr?.seoTitle ?? tr?.title ?? page.key, description: tr?.seoDescription ?? '', canonical: publicUrl(`/pages/${page.key}`) },
    };
  }

  async journalList(locale: Locale, pagination: Pagination, category?: string) {
    const where: Prisma.JournalPostWhereInput = { status: 'PUBLISHED', publishedAt: { lte: new Date() }, category };
    const [rows, total] = await Promise.all([
      this.prisma.journalPost.findMany({ where, orderBy: { publishedAt: 'desc' }, ...skipTake(pagination), include: { translations: true } }),
      this.prisma.journalPost.count({ where }),
    ]);
    return toPage(
      rows.map((p) => {
        const tr = pickTranslation(p.translations, locale);
        return { id: p.id, slug: p.slug, coverUrl: p.coverUrl, category: p.category, authorName: p.authorName, publishedAt: p.publishedAt, title: tr?.title ?? p.slug, excerpt: tr?.excerpt ?? null };
      }),
      total,
      pagination,
    );
  }

  async journalPost(slug: string, locale: Locale) {
    const p = await this.prisma.journalPost.findFirst({ where: { slug, status: 'PUBLISHED', publishedAt: { lte: new Date() } }, include: { translations: true } });
    if (!p) throw AppError.notFound();
    const tr = pickTranslation(p.translations, locale);
    const title = tr?.title ?? p.slug;
    return {
      id: p.id,
      slug: p.slug,
      coverUrl: p.coverUrl,
      category: p.category,
      authorName: p.authorName,
      publishedAt: p.publishedAt,
      title,
      excerpt: tr?.excerpt ?? null,
      content: tr?.content ?? '',
      seo: {
        title: tr?.seoTitle ?? title,
        description: tr?.seoDescription ?? tr?.excerpt ?? '',
        canonical: publicUrl(`/journal/${p.slug}`),
        jsonLd: {
          '@context': 'https://schema.org',
          '@type': 'BlogPosting',
          headline: title,
          datePublished: p.publishedAt?.toISOString(),
          image: p.coverUrl ?? undefined,
          author: p.authorName ? { '@type': 'Person', name: p.authorName } : undefined,
        },
      },
    };
  }

  // ---------------------------------------------------------------- newsletter & contact

  async subscribe(email: string, locale: Locale) {
    const e = email.toLowerCase();
    await this.prisma.newsletterSubscriber.upsert({
      where: { email: e },
      create: { email: e, locale },
      update: { unsubscribedAt: null, locale },
    });
    // Same answer whether or not the address already existed (no enumeration).
    return { ok: true };
  }

  async unsubscribe(email: string, token: string) {
    if (!safeEqual(token, newsletterToken(email))) throw AppError.forbidden();
    await this.prisma.newsletterSubscriber.updateMany({ where: { email: email.toLowerCase() }, data: { unsubscribedAt: new Date() } });
    return { ok: true };
  }

  async submitContact(input: { name: string; email: string; phone?: string; subject?: string; message: string }) {
    await this.prisma.contactMessage.create({ data: { name: input.name, email: input.email.toLowerCase(), phone: input.phone ?? null, subject: input.subject ?? null, message: input.message } });
    return { ok: true };
  }

  // ================================================================ SEO files

  /** All public URLs, used by both the XML sitemap and the JSON variant. */
  async sitemapEntries(): Promise<Array<{ path: string; lastmod?: Date; priority: number }>> {
    const [products, collections, categories, posts, pages] = await Promise.all([
      this.prisma.product.findMany({ where: { status: 'ACTIVE', deletedAt: null }, select: { slug: true, updatedAt: true } }),
      this.prisma.collection.findMany({ where: { active: true, deletedAt: null }, select: { slug: true, updatedAt: true } }),
      this.prisma.category.findMany({ where: { active: true, deletedAt: null }, select: { slug: true, updatedAt: true } }),
      this.prisma.journalPost.findMany({ where: { status: 'PUBLISHED', publishedAt: { lte: new Date() } }, select: { slug: true, updatedAt: true } }),
      this.prisma.page.findMany({ where: { active: true }, select: { key: true, updatedAt: true } }),
    ]);
    return [
      { path: '/', priority: 1 },
      { path: '/shop', priority: 0.9 },
      { path: '/build', priority: 0.9 },
      { path: '/journal', priority: 0.6 },
      ...products.map((p) => ({ path: `/products/${p.slug}`, lastmod: p.updatedAt, priority: 0.8 })),
      ...collections.map((c) => ({ path: `/collections/${c.slug}`, lastmod: c.updatedAt, priority: 0.7 })),
      ...categories.map((c) => ({ path: `/categories/${c.slug}`, lastmod: c.updatedAt, priority: 0.7 })),
      ...posts.map((p) => ({ path: `/journal/${p.slug}`, lastmod: p.updatedAt, priority: 0.5 })),
      ...pages.map((p) => ({ path: `/pages/${p.key}`, lastmod: p.updatedAt, priority: 0.4 })),
    ];
  }

  async sitemapXml(): Promise<string> {
    const entries = await this.sitemapEntries();
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const urls = entries
      .map((e) => `<url><loc>${esc(publicUrl(e.path))}</loc>${e.lastmod ? `<lastmod>${e.lastmod.toISOString()}</lastmod>` : ''}<priority>${e.priority}</priority></url>`)
      .join('');
    return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
  }

  robotsTxt(): string {
    return ['User-agent: *', 'Allow: /', 'Disallow: /account', 'Disallow: /cart', 'Disallow: /checkout', 'Disallow: /admin', `Sitemap: ${publicUrl('/sitemap.xml')}`, ''].join('\n');
  }

  // ================================================================ admin (generic over kinds)

  private delegate(kind: ContentKind): any {
    return (this.prisma as any)[KINDS[kind].model];
  }

  private include(kind: ContentKind) {
    const c = KINDS[kind];
    const inc: Record<string, unknown> = {};
    if (c.trModel) inc.translations = true;
    if (kind === 'homepage') {
      inc.products = { orderBy: { sortOrder: 'asc' }, select: { productId: true, sortOrder: true } };
      inc.collections = { orderBy: { sortOrder: 'asc' }, select: { collectionId: true, sortOrder: true } };
    }
    return Object.keys(inc).length ? inc : undefined;
  }

  async adminList(kind: ContentKind, pagination: Pagination) {
    const d = this.delegate(kind);
    const [items, total] = await Promise.all([
      d.findMany({ orderBy: KINDS[kind].orderBy, ...skipTake(pagination), include: this.include(kind) }),
      d.count(),
    ]);
    return toPage(items, total, pagination);
  }

  async adminGet(kind: ContentKind, id: string) {
    const row = await this.delegate(kind).findUnique({ where: { id }, include: this.include(kind) });
    if (!row) throw AppError.notFound();
    return row;
  }

  private cleanTranslations(kind: ContentKind, translations: Translation[] | undefined) {
    const rich = KINDS[kind].richFields ?? [];
    return (translations ?? []).map((t) => {
      const copy = { ...t };
      for (const f of rich) if (typeof copy[f] === 'string') copy[f] = sanitizeRichText(copy[f] as string);
      return copy;
    });
  }

  async adminCreate(kind: ContentKind, data: Record<string, any>, translations?: Translation[], links?: { productIds?: string[]; collectionIds?: string[] }) {
    const cfg = KINDS[kind];
    const { prepared } = this.prepare(kind, data, undefined);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const row = await (tx as any)[cfg.model].create({
          data: { ...prepared, ...(cfg.trModel ? { translations: { create: this.cleanTranslations(kind, translations) } } : {}) },
        });
        if (kind === 'homepage') await this.syncHomepageLinks(tx, row.id, links);
        return row;
      });
      return this.adminGet(kind, created.id);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw AppError.conflict('CONFLICT');
      throw e;
    }
  }

  async adminUpdate(kind: ContentKind, id: string, data: Record<string, any>, translations?: Translation[], links?: { productIds?: string[]; collectionIds?: string[] }) {
    const cfg = KINDS[kind];
    const existing = await this.adminGet(kind, id);
    const { prepared } = this.prepare(kind, data, existing);
    try {
      await this.prisma.$transaction(async (tx) => {
        await (tx as any)[cfg.model].update({ where: { id }, data: prepared });
        if (cfg.trModel && translations) {
          for (const t of this.cleanTranslations(kind, translations)) {
            const { locale, ...fields } = t;
            await (tx as any)[cfg.trModel].upsert({
              where: { [`${cfg.fk}_locale`]: { [cfg.fk!]: id, locale } },
              create: { [cfg.fk!]: id, locale, ...fields },
              update: fields,
            });
          }
        }
        if (kind === 'homepage' && links) await this.syncHomepageLinks(tx, id, links);
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw AppError.conflict('CONFLICT');
      throw e;
    }
    return this.adminGet(kind, id);
  }

  async adminDelete(kind: ContentKind, id: string) {
    await this.adminGet(kind, id);
    await this.delegate(kind).delete({ where: { id } });
    return { ok: true };
  }

  /** Kind-specific normalisation (publish timestamps…). */
  private prepare(kind: ContentKind, data: Record<string, any>, existing: any) {
    const prepared = { ...data };
    if (kind === 'journal') {
      const status = prepared.status ?? existing?.status;
      if (status === 'PUBLISHED' && !prepared.publishedAt && !existing?.publishedAt) prepared.publishedAt = new Date();
      if (status === 'DRAFT' && prepared.publishedAt === undefined && existing?.publishedAt) prepared.publishedAt = null;
    }
    return { prepared };
  }

  private async syncHomepageLinks(tx: Prisma.TransactionClient, sectionId: string, links?: { productIds?: string[]; collectionIds?: string[] }) {
    if (!links) return;
    if (links.productIds) {
      await tx.homepageSectionProduct.deleteMany({ where: { sectionId } });
      const ids = [...new Set(links.productIds)];
      if (ids.length) await tx.homepageSectionProduct.createMany({ data: ids.map((productId, i) => ({ sectionId, productId, sortOrder: i })) });
    }
    if (links.collectionIds) {
      await tx.homepageSectionCollection.deleteMany({ where: { sectionId } });
      const ids = [...new Set(links.collectionIds)];
      if (ids.length) await tx.homepageSectionCollection.createMany({ data: ids.map((collectionId, i) => ({ sectionId, collectionId, sortOrder: i })) });
    }
  }

  // ---------------------------------------------------------------- admin: contact + newsletter

  async contactList(status: string | undefined, pagination: Pagination) {
    const where: Prisma.ContactMessageWhereInput = { status: status as any };
    const [items, total] = await Promise.all([
      this.prisma.contactMessage.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(pagination) }),
      this.prisma.contactMessage.count({ where }),
    ]);
    return toPage(items, total, pagination);
  }

  async contactSetStatus(id: string, status: 'NEW' | 'READ' | 'REPLIED') {
    const r = await this.prisma.contactMessage.updateMany({ where: { id }, data: { status } });
    if (r.count === 0) throw AppError.notFound();
    return { ok: true };
  }

  async newsletterList(pagination: Pagination, activeOnly: boolean) {
    const where: Prisma.NewsletterSubscriberWhereInput = activeOnly ? { unsubscribedAt: null } : {};
    const [items, total] = await Promise.all([
      this.prisma.newsletterSubscriber.findMany({ where, orderBy: { subscribedAt: 'desc' }, ...skipTake(pagination) }),
      this.prisma.newsletterSubscriber.count({ where }),
    ]);
    return toPage(items, total, pagination);
  }
}
