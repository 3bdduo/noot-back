import { BadRequestException, Body, Controller, Delete, Get, Header, HttpCode, Param, Patch, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { localeSchema } from '@nb/shared';
import type { Locale } from '@nb/shared';
import { Public, RateLimit, ReqLocale, RequirePermissions } from '../../common/decorators.js';
import { AppError } from '../../common/errors/app-error.js';
import { ZodPipe } from '../../common/pipes/zod.pipe.js';
import { paginationSchema } from '../../common/utils/pagination.js';
import { CONTENT_KINDS, ContentService } from './content.service.js';
import type { ContentKind } from './content.service.js';

const str = (max: number) => z.string().trim().max(max);
const url = z.string().trim().max(1000);
const optUrl = url.nullable().optional();
const trArray = <T extends z.ZodRawShape>(shape: T) => z.array(z.object({ locale: localeSchema, ...shape })).max(2).optional();

const placementSchema = z.object({ placement: str(40).optional() });
const faqQuery = z.object({ category: str(60).optional() });
const journalQuery = paginationSchema.extend({ category: str(60).optional() });
const emailSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) });
const unsubscribeSchema = emailSchema.extend({ token: z.string().min(20).max(128) });
const contactSchema = z.object({
  name: str(100).min(1),
  email: z.string().trim().toLowerCase().email().max(254),
  phone: str(30).optional(),
  subject: str(150).optional(),
  message: str(3000).min(5),
  /** Honeypot: real users never fill this hidden field. */
  website: str(200).optional(),
});

// ---- admin schemas per kind (flat body: scalars + translations + links)
const scalarSchemas: Record<ContentKind, z.ZodObject<any>> = {
  banners: z.object({
    placement: str(40).min(1),
    imageUrl: url.min(1),
    mobileImageUrl: optUrl,
    linkUrl: optUrl,
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    active: z.boolean().optional(),
    startsAt: z.coerce.date().nullable().optional(),
    endsAt: z.coerce.date().nullable().optional(),
  }),
  testimonials: z.object({
    authorName: str(100).min(1),
    avatarUrl: optUrl,
    rating: z.number().int().min(1).max(5).nullable().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    active: z.boolean().optional(),
  }),
  faq: z.object({ category: str(60).nullable().optional(), sortOrder: z.number().int().min(0).max(10_000).optional(), active: z.boolean().optional() }),
  pages: z.object({ key: str(60).regex(/^[a-z0-9-]+$/, { message: 'INVALID_SLUG' }), active: z.boolean().optional() }),
  journal: z.object({
    slug: str(120).regex(/^[a-z0-9؀-ۿ-]+$/i, { message: 'INVALID_SLUG' }),
    coverUrl: optUrl,
    authorName: str(100).nullable().optional(),
    category: str(60).nullable().optional(),
    status: z.enum(['DRAFT', 'PUBLISHED']).optional(),
    publishedAt: z.coerce.date().nullable().optional(),
  }),
  homepage: z.object({
    type: z.enum(['HERO', 'FEATURED_PRODUCTS', 'COLLECTIONS', 'BRAND_STATEMENT', 'BUILD_YOUR_NOTEBOOK', 'PERSONALIZATION', 'PAPER_QUALITY', 'PACKAGING', 'GIFTS', 'TESTIMONIALS', 'INSTAGRAM', 'NEWSLETTER']),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    active: z.boolean().optional(),
    imageUrl: optUrl,
    linkUrl: optUrl,
  }),
  instagram: z.object({
    imageUrl: url.min(1),
    linkUrl: url.min(1),
    caption: str(300).nullable().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    active: z.boolean().optional(),
  }),
};

const translationShapes: Partial<Record<ContentKind, z.ZodRawShape>> = {
  banners: { title: str(150).nullable().optional(), subtitle: str(300).nullable().optional(), ctaLabel: str(60).nullable().optional() },
  testimonials: { quote: str(1000).min(1), authorTitle: str(100).nullable().optional() },
  faq: { question: str(300).min(1), answer: str(5000).min(1) },
  pages: { title: str(150).min(1), content: str(100_000), seoTitle: str(150).nullable().optional(), seoDescription: str(300).nullable().optional() },
  journal: { title: str(200).min(1), excerpt: str(500).nullable().optional(), content: str(200_000), seoTitle: str(150).nullable().optional(), seoDescription: str(300).nullable().optional() },
  homepage: { title: str(200).nullable().optional(), subtitle: str(400).nullable().optional(), body: str(3000).nullable().optional(), ctaLabel: str(60).nullable().optional() },
};

function bodySchema(kind: ContentKind, partial: boolean) {
  const base = partial ? scalarSchemas[kind].partial() : scalarSchemas[kind];
  const extra: Record<string, any> = {};
  const trShape = translationShapes[kind];
  if (trShape) extra.translations = trArray(trShape);
  if (kind === 'homepage') {
    extra.productIds = z.array(z.string().max(64)).max(24).optional();
    extra.collectionIds = z.array(z.string().max(64)).max(24).optional();
  }
  return base.extend(extra);
}

function parseKind(kind: string): ContentKind {
  if (!(CONTENT_KINDS as readonly string[]).includes(kind)) throw new BadRequestException('unknown content kind');
  return kind as ContentKind;
}

function parseBody(kind: ContentKind, partial: boolean, body: unknown) {
  const parsed = bodySchema(kind, partial).safeParse(body);
  if (!parsed.success) {
    throw AppError.badRequest(
      'VALIDATION_ERROR',
      {},
      parsed.error.issues.map((i) => ({ field: i.path.join('.'), code: i.message === 'Required' ? 'REQUIRED' : i.message })),
    );
  }
  const { translations, productIds, collectionIds, ...data } = parsed.data as Record<string, any>;
  return { data, translations, links: kind === 'homepage' ? { productIds, collectionIds } : undefined };
}

const PUBLIC_CACHE = 'public, max-age=60, s-maxage=120, stale-while-revalidate=300';

@Controller()
export class ContentController {
  constructor(private readonly content: ContentService) {}

  // ================= public

  @Public()
  @Header('Cache-Control', PUBLIC_CACHE)
  @Get('content/homepage')
  homepage(@ReqLocale() locale: Locale) {
    return this.content.homepage(locale);
  }

  @Public()
  @Header('Cache-Control', PUBLIC_CACHE)
  @Get('content/banners')
  banners(@ReqLocale() locale: Locale, @Query(new ZodPipe(placementSchema)) q: z.infer<typeof placementSchema>) {
    return this.content.banners(locale, q.placement);
  }

  @Public()
  @Header('Cache-Control', PUBLIC_CACHE)
  @Get('content/testimonials')
  testimonials(@ReqLocale() locale: Locale) {
    return this.content.testimonials(locale);
  }

  @Public()
  @Header('Cache-Control', PUBLIC_CACHE)
  @Get('content/faq')
  faq(@ReqLocale() locale: Locale, @Query(new ZodPipe(faqQuery)) q: z.infer<typeof faqQuery>) {
    return this.content.faq(locale, q.category);
  }

  @Public()
  @Header('Cache-Control', PUBLIC_CACHE)
  @Get('content/instagram')
  instagram() {
    return this.content.instagram();
  }

  @Public()
  @Header('Cache-Control', PUBLIC_CACHE)
  @Get('content/pages/:key')
  page(@Param('key') key: string, @ReqLocale() locale: Locale) {
    return this.content.page(key, locale);
  }

  @Public()
  @Header('Cache-Control', PUBLIC_CACHE)
  @Get('journal')
  journal(@ReqLocale() locale: Locale, @Query(new ZodPipe(journalQuery)) q: z.infer<typeof journalQuery>) {
    const { category, ...p } = q;
    return this.content.journalList(locale, p, category);
  }

  @Public()
  @Header('Cache-Control', PUBLIC_CACHE)
  @Get('journal/:slug')
  journalPost(@Param('slug') slug: string, @ReqLocale() locale: Locale) {
    return this.content.journalPost(slug, locale);
  }

  @Public()
  @RateLimit(5, 3600)
  @Post('newsletter/subscribe')
  subscribe(@ReqLocale() locale: Locale, @Body(new ZodPipe(emailSchema)) body: z.infer<typeof emailSchema>) {
    return this.content.subscribe(body.email, locale);
  }

  @Public()
  @RateLimit(10, 3600)
  @Post('newsletter/unsubscribe')
  unsubscribe(@Body(new ZodPipe(unsubscribeSchema)) body: z.infer<typeof unsubscribeSchema>) {
    return this.content.unsubscribe(body.email, body.token);
  }

  @Public()
  @RateLimit(5, 3600)
  @HttpCode(201)
  @Post('contact')
  async contact(@Body(new ZodPipe(contactSchema)) body: z.infer<typeof contactSchema>) {
    if (body.website) return { ok: true }; // bot: pretend success, store nothing
    const { website: _w, ...input } = body;
    return this.content.submitContact(input);
  }

  // ================= SEO files (the frontend proxies /sitemap.xml and /robots.txt to these)

  @Public()
  @Header('Cache-Control', 'public, max-age=300, s-maxage=3600')
  @Get('seo/sitemap.xml')
  async sitemap(@Res() res: Response) {
    res.type('application/xml').send(await this.content.sitemapXml());
  }

  @Public()
  @Get('seo/sitemap.json')
  sitemapJson() {
    return this.content.sitemapEntries();
  }

  @Public()
  @Header('Cache-Control', 'public, max-age=3600')
  @Get('seo/robots.txt')
  robots(@Res() res: Response) {
    res.type('text/plain').send(this.content.robotsTxt());
  }

  // ================= admin: generic content CRUD  (/admin/content/:kind)

  @RequirePermissions('content.read')
  @Get('admin/content/:kind')
  adminList(@Param('kind') kind: string, @Query(new ZodPipe(paginationSchema)) q: z.infer<typeof paginationSchema>) {
    return this.content.adminList(parseKind(kind), q);
  }

  @RequirePermissions('content.read')
  @Get('admin/content/:kind/:id')
  adminGet(@Param('kind') kind: string, @Param('id') id: string) {
    return this.content.adminGet(parseKind(kind), id);
  }

  @RequirePermissions('content.create')
  @HttpCode(201)
  @Post('admin/content/:kind')
  adminCreate(@Param('kind') kind: string, @Body() body: unknown) {
    const k = parseKind(kind);
    const { data, translations, links } = parseBody(k, false, body);
    return this.content.adminCreate(k, data, translations, links);
  }

  @RequirePermissions('content.update')
  @Patch('admin/content/:kind/:id')
  adminUpdate(@Param('kind') kind: string, @Param('id') id: string, @Body() body: unknown) {
    const k = parseKind(kind);
    const { data, translations, links } = parseBody(k, true, body);
    return this.content.adminUpdate(k, id, data, translations, links);
  }

  @RequirePermissions('content.delete')
  @Delete('admin/content/:kind/:id')
  adminDelete(@Param('kind') kind: string, @Param('id') id: string) {
    return this.content.adminDelete(parseKind(kind), id);
  }

  // ================= admin: inbox + subscribers

  @RequirePermissions('content.read')
  @Get('admin/contact-messages')
  contactList(@Query(new ZodPipe(paginationSchema.extend({ status: z.enum(['NEW', 'READ', 'REPLIED']).optional() }))) q: any) {
    const { status, ...p } = q;
    return this.content.contactList(status, p);
  }

  @RequirePermissions('content.update')
  @Patch('admin/contact-messages/:id')
  contactStatus(@Param('id') id: string, @Body(new ZodPipe(z.object({ status: z.enum(['NEW', 'READ', 'REPLIED']) }))) body: { status: 'NEW' | 'READ' | 'REPLIED' }) {
    return this.content.contactSetStatus(id, body.status);
  }

  @RequirePermissions('content.read')
  @Get('admin/newsletter')
  newsletter(@Query(new ZodPipe(paginationSchema.extend({ active: z.enum(['true', 'false']).optional() }))) q: any) {
    const { active, ...p } = q;
    return this.content.newsletterList(p, active === 'true');
  }
}
