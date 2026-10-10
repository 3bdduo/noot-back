/**
 * Seed: `npm run db:seed`
 *  - always: permissions, the 5 system roles and their permission matrix, the first Super Admin,
 *            shipping zones with governorate assignments (INACTIVE until you review the fees)
 *  - SEED_DEMO=true: also demo catalogue (customizer steps, a customizable notebook, categories, collections,
 *            homepage, FAQ, legal pages) and ACTIVE shipping zones so the store works end to end immediately.
 * Safe to run repeatedly (upserts / existence checks).
 */
import { PrismaClient } from '@prisma/client';
import { PERMISSIONS, ROLE_KEYS, ROLE_LABELS, ROLE_PERMISSIONS } from '@nb/shared';
import { hashPassword } from '../src/common/crypto/password.js';
import { normalizeSearch } from '../src/common/utils/normalize.js';

const prisma = new PrismaClient();
const demo = ['1', 'true', 'yes'].includes(String(process.env.SEED_DEMO ?? '').toLowerCase());

async function seedRbac() {
  for (const key of PERMISSIONS) {
    await prisma.permission.upsert({ where: { key }, create: { key }, update: {} });
  }
  const perms = new Map((await prisma.permission.findMany()).map((p) => [p.key, p.id]));
  for (const key of ROLE_KEYS) {
    const role = await prisma.role.upsert({
      where: { key },
      create: { key, nameAr: ROLE_LABELS[key].ar, nameEn: ROLE_LABELS[key].en, isSystem: true },
      update: {},
    });
    // New permissions are added to system roles on every seed; permissions an admin removed by hand are NOT re-added
    // once the role has any permission, except for super_admin which always owns everything.
    const existing = await prisma.rolePermission.count({ where: { roleId: role.id } });
    if (existing === 0 || key === 'super_admin') {
      for (const p of ROLE_PERMISSIONS[key]) {
        await prisma.rolePermission.upsert({
          where: { roleId_permissionId: { roleId: role.id, permissionId: perms.get(p)! } },
          create: { roleId: role.id, permissionId: perms.get(p)! },
          update: {},
        });
      }
    }
  }
  console.log(`RBAC: ${PERMISSIONS.length} permissions, ${ROLE_KEYS.length} roles`);
}

async function seedAdmin() {
  const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) {
    console.log('Super Admin: skipped (SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD not set)');
    return;
  }
  const role = await prisma.role.findUniqueOrThrow({ where: { key: 'super_admin' } });
  let user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    user = await prisma.user.create({
      data: { email, passwordHash: await hashPassword(password), firstName: 'Super', lastName: 'Admin', emailVerifiedAt: new Date(), locale: 'ar' },
    });
    console.log(`Super Admin created: ${email}  (change the password after the first login)`);
  } else {
    console.log(`Super Admin exists: ${email}`);
  }
  await prisma.userRole.upsert({ where: { userId_roleId: { userId: user.id, roleId: role.id } }, create: { userId: user.id, roleId: role.id }, update: {} });
}

const ZONES = [
  { ar: 'القاهرة الكبرى', en: 'Greater Cairo', days: [1, 2], fee: 6000, free: 150000, codes: ['CAI', 'GIZ', 'QLY'] },
  { ar: 'الإسكندرية والدلتا', en: 'Alexandria & Delta', days: [2, 3], fee: 7500, free: 150000, codes: ['ALX', 'DKH', 'GHR', 'MNF', 'BHR', 'KFS', 'DMT', 'SHR'] },
  { ar: 'القناة وسيناء والساحل', en: 'Canal, Sinai & Coast', days: [3, 4], fee: 9000, free: null, codes: ['PTS', 'ISM', 'SUZ', 'MAT', 'NSN', 'SSN', 'FYM', 'BNS'] },
  { ar: 'الصعيد والمناطق النائية', en: 'Upper Egypt & Remote', days: [4, 6], fee: 11000, free: null, codes: ['MNY', 'AST', 'SOH', 'QEN', 'LXR', 'ASN', 'RSS', 'WAD'] },
];

async function seedShipping() {
  if ((await prisma.shippingZone.count()) > 0) {
    console.log('Shipping: zones already exist, untouched');
    return;
  }
  for (const [i, z] of ZONES.entries()) {
    await prisma.shippingZone.create({
      data: {
        nameAr: z.ar,
        nameEn: z.en,
        estimatedDaysMin: z.days[0],
        estimatedDaysMax: z.days[1],
        active: demo,
        sortOrder: i,
        governorates: { create: z.codes.map((governorate) => ({ governorate })) },
        rates: { create: [{ name: 'Standard', baseFee: z.fee, freeOverSubtotal: z.free, codAvailable: true, active: true }] },
      },
    });
  }
  console.log(`Shipping: ${ZONES.length} zones created (${demo ? 'ACTIVE (demo)' : 'INACTIVE: review fees, then activate in the admin panel'})`);
}

// ---------------------------------------------------------------------------------------------------- demo data

type Tr = { ar: string; en: string };
const tr = (t: Tr, extra: Record<string, string | undefined> = {}) => [
  { locale: 'ar' as const, name: t.ar, ...extra },
  { locale: 'en' as const, name: t.en, ...extra },
];

async function group(
  code: string,
  stepKey: string,
  type: 'SINGLE_CHOICE' | 'MULTI_CHOICE' | 'TEXT' | 'DATE' | 'FILE',
  name: Tr,
  sortOrder: number,
  extra: Record<string, unknown> = {},
  options: Array<{ code: string; name: Tr; priceDelta?: number; colorHex?: string; isDefault?: boolean }> = [],
  help?: Tr,
) {
  const existing = await prisma.customizationGroup.findUnique({ where: { code } });
  if (existing) return existing;
  return prisma.customizationGroup.create({
    data: {
      code,
      stepKey,
      type,
      sortOrder,
      ...extra,
      translations: {
        create: [
          { locale: 'ar', name: name.ar, helpText: help?.ar },
          { locale: 'en', name: name.en, helpText: help?.en },
        ],
      },
      options: {
        create: options.map((o, i) => ({
          code: o.code,
          priceDelta: o.priceDelta ?? 0,
          colorHex: o.colorHex,
          isDefault: o.isDefault ?? false,
          sortOrder: i,
          translations: { create: tr(o.name) },
        })),
      },
    },
  });
}

async function seedDemo() {
  if ((await prisma.product.count()) > 0) {
    console.log('Demo: catalogue is not empty, skipped');
    return;
  }

  const groups = [
    await group('purpose', 'purpose', 'SINGLE_CHOICE', { ar: 'الغرض', en: 'Purpose' }, 0, { required: true, minSelect: 1, maxSelect: 1 }, [
      { code: 'study', name: { ar: 'دراسة', en: 'Study' } },
      { code: 'work', name: { ar: 'عمل', en: 'Work' } },
      { code: 'journal', name: { ar: 'يوميات', en: 'Journaling' } },
      { code: 'gift', name: { ar: 'هدية', en: 'Gift' } },
    ]),
    await group('size', 'size', 'SINGLE_CHOICE', { ar: 'المقاس', en: 'Size' }, 0, { required: true, minSelect: 1, maxSelect: 1 }, [
      { code: 'a6', name: { ar: 'A6 جيب', en: 'A6 Pocket' }, priceDelta: -3000 },
      { code: 'a5', name: { ar: 'A5 قياسي', en: 'A5 Standard' }, isDefault: true },
      { code: 'b5', name: { ar: 'B5 كبير', en: 'B5 Large' }, priceDelta: 4000 },
    ]),
    await group('cover_material', 'cover', 'SINGLE_CHOICE', { ar: 'خامة الغلاف', en: 'Cover material' }, 0, { required: true, minSelect: 1, maxSelect: 1 }, [
      { code: 'linen', name: { ar: 'كتان', en: 'Linen' }, priceDelta: 0, isDefault: true },
      { code: 'vegan_leather', name: { ar: 'جلد نباتي', en: 'Vegan leather' }, priceDelta: 8000 },
      { code: 'leather', name: { ar: 'جلد طبيعي', en: 'Genuine leather' }, priceDelta: 18000 },
    ]),
    await group('cover_color', 'cover', 'SINGLE_CHOICE', { ar: 'لون الغلاف', en: 'Cover color' }, 1, { required: true, minSelect: 1, maxSelect: 1 }, [
      { code: 'burgundy', name: { ar: 'عنابي', en: 'Burgundy' }, colorHex: '#6E2635', isDefault: true },
      { code: 'navy', name: { ar: 'كحلي', en: 'Navy' }, colorHex: '#1F2A44' },
      { code: 'forest', name: { ar: 'أخضر غامق', en: 'Forest' }, colorHex: '#2F4A3A' },
      { code: 'black', name: { ar: 'أسود', en: 'Black' }, colorHex: '#1A1A1A' },
      { code: 'tan', name: { ar: 'بيج', en: 'Tan' }, colorHex: '#C8A878' },
    ]),
    await group('paper_type', 'paper', 'SINGLE_CHOICE', { ar: 'نوع الورق', en: 'Paper' }, 0, { required: true, minSelect: 1, maxSelect: 1 }, [
      { code: 'lined', name: { ar: 'مسطّر', en: 'Lined' }, isDefault: true },
      { code: 'dotted', name: { ar: 'منقّط', en: 'Dotted' } },
      { code: 'grid', name: { ar: 'مربعات', en: 'Grid' } },
      { code: 'blank', name: { ar: 'سادة', en: 'Blank' } },
    ]),
    await group(
      'name_text',
      'personalization',
      'TEXT',
      { ar: 'اسم على الغلاف', en: 'Name on cover' },
      0,
      { exclusiveWithinStep: true, minLength: 1, maxLength: 20, allowedCharsets: ['ARABIC', 'LATIN', 'SPACE'], priceDelta: 5000 },
      [],
      { ar: 'حتى 20 حرفاً', en: 'Up to 20 characters' },
    ),
    await group('initials', 'personalization', 'TEXT', { ar: 'الأحرف الأولى', en: 'Initials' }, 1, { exclusiveWithinStep: true, minLength: 1, maxLength: 3, allowedCharsets: ['ARABIC', 'LATIN'], priceDelta: 4000 }),
    await group(
      'custom_artwork',
      'personalization',
      'FILE',
      { ar: 'ارفع تصميمك', en: 'Upload your design' },
      2,
      { exclusiveWithinStep: true, allowedMimeTypes: ['image/png', 'image/jpeg', 'application/pdf'], maxFileSizeBytes: 10 * 1024 * 1024, minWidthPx: 1000, minHeightPx: 1000, priceDelta: 10000 },
      [],
      { ar: 'PNG أو JPG أو PDF، 1000×1000 بكسل على الأقل', en: 'PNG, JPG or PDF, at least 1000×1000 px' },
    ),
    await group('special_date', 'personalization', 'DATE', { ar: 'تاريخ مميز', en: 'Special date' }, 3, { priceDelta: 0 }),
    await group('accessories', 'accessories', 'MULTI_CHOICE', { ar: 'إكسسوارات', en: 'Accessories' }, 0, { minSelect: 0, maxSelect: 3 }, [
      { code: 'bookmark', name: { ar: 'فاصل كتب', en: 'Bookmark' }, priceDelta: 3000 },
      { code: 'pen', name: { ar: 'قلم فاخر', en: 'Premium pen' }, priceDelta: 8000 },
      { code: 'stickers', name: { ar: 'ستيكرز', en: 'Sticker pack' }, priceDelta: 2500 },
    ]),
    await group('packaging', 'packaging', 'SINGLE_CHOICE', { ar: 'التغليف', en: 'Packaging' }, 0, { required: true, minSelect: 1, maxSelect: 1 }, [
      { code: 'standard', name: { ar: 'تغليف عادي', en: 'Standard' }, isDefault: true },
      { code: 'gift_box', name: { ar: 'علبة هدية', en: 'Gift box' }, priceDelta: 10000 },
    ]),
  ];

  const cat = await prisma.category.create({
    data: { slug: 'notebooks', translations: { create: tr({ ar: 'الدفاتر', en: 'Notebooks' }, { description: undefined }) } },
  });
  const catPlanners = await prisma.category.create({ data: { slug: 'planners', translations: { create: tr({ ar: 'المخططات', en: 'Planners' }) } } });
  const col = await prisma.collection.create({
    data: { slug: 'signature', featured: true, translations: { create: tr({ ar: 'مجموعة التوقيع', en: 'Signature collection' }) } },
  });

  const mk = async (
    slug: string,
    name: Tr,
    desc: Tr,
    basePrice: number,
    sku: string,
    customizable: boolean,
    categoryId: string,
    stock: number,
  ) => {
    const product = await prisma.product.create({
      data: {
        slug,
        status: 'ACTIVE',
        basePrice,
        isCustomizable: customizable,
        isGift: customizable,
        featured: true,
        leadTimeDays: customizable ? 3 : 0,
        publishedAt: new Date(),
        searchText: normalizeSearch(`${name.ar} ${name.en} ${desc.ar} ${desc.en}`),
        translations: {
          create: [
            { locale: 'ar', name: name.ar, shortDescription: desc.ar, description: desc.ar },
            { locale: 'en', name: name.en, shortDescription: desc.en, description: desc.en },
          ],
        },
        variants: {
          create: [
            {
              sku,
              isDefault: true,
              sortOrder: 0,
              translations: { create: tr({ ar: 'قياسي', en: 'Standard' }) },
              inventory: { create: { quantity: stock, sku } },
            },
          ],
        },
        categories: { create: [{ categoryId }] },
        collections: { create: [{ collectionId: col.id }] },
      },
    });
    return product;
  };

  const custom = await mk(
    'custom-notebook',
    { ar: 'دفتر مخصّص', en: 'Custom notebook' },
    { ar: 'صمّم دفترك بنفسك: المقاس والغلاف والورق والاسم والتغليف.', en: 'Design your own: size, cover, paper, name and packaging.' },
    45000,
    'NB-CUSTOM-STD',
    true,
    cat.id,
    500,
  );
  await prisma.productCustomization.createMany({ data: groups.map((g, i) => ({ productId: custom.id, groupId: g.id, sortOrder: i })) });
  await mk('weekly-planner', { ar: 'مخطط أسبوعي', en: 'Weekly planner' }, { ar: 'مخطط أسبوعي أنيق جاهز.', en: 'A ready-made weekly planner.' }, 28000, 'NB-PLANNER-01', false, catPlanners.id, 80);

  await prisma.homepageSection.createMany({
    data: [
      { type: 'HERO', sortOrder: 0 },
      { type: 'BUILD_YOUR_NOTEBOOK', sortOrder: 1 },
      { type: 'FEATURED_PRODUCTS', sortOrder: 2 },
      { type: 'COLLECTIONS', sortOrder: 3 },
      { type: 'TESTIMONIALS', sortOrder: 4 },
      { type: 'NEWSLETTER', sortOrder: 5 },
    ],
  });
  const sections = await prisma.homepageSection.findMany();
  const titles: Record<string, Tr> = {
    HERO: { ar: 'دفترك. تصميمك. توقيعك.', en: 'Your notebook. Your design. Your signature.' },
    BUILD_YOUR_NOTEBOOK: { ar: 'صمّم دفترك الآن', en: 'Build your notebook' },
    FEATURED_PRODUCTS: { ar: 'مختارات', en: 'Featured' },
    COLLECTIONS: { ar: 'المجموعات', en: 'Collections' },
    TESTIMONIALS: { ar: 'آراء العملاء', en: 'What customers say' },
    NEWSLETTER: { ar: 'اشترك في نشرتنا', en: 'Join our newsletter' },
  };
  for (const s of sections) {
    const t = titles[s.type];
    if (t) await prisma.homepageSectionTranslation.createMany({ data: [{ sectionId: s.id, locale: 'ar', title: t.ar }, { sectionId: s.id, locale: 'en', title: t.en }] });
  }
  const colSection = sections.find((s) => s.type === 'COLLECTIONS');
  if (colSection) await prisma.homepageSectionCollection.create({ data: { sectionId: colSection.id, collectionId: col.id } });

  const faq = await prisma.faqItem.create({ data: { category: 'shipping', sortOrder: 0 } });
  await prisma.faqItemTranslation.createMany({
    data: [
      { faqId: faq.id, locale: 'ar', question: 'كم يستغرق التوصيل؟', answer: 'من 1 إلى 6 أيام عمل حسب المحافظة، بالإضافة إلى مدة تجهيز المنتجات المخصصة.' },
      { faqId: faq.id, locale: 'en', question: 'How long does delivery take?', answer: '1 to 6 working days depending on the governorate, plus production time for personalised items.' },
    ],
  });

  const legal: Array<[string, Tr]> = [
    ['terms', { ar: 'الشروط والأحكام', en: 'Terms & Conditions' }],
    ['privacy', { ar: 'سياسة الخصوصية', en: 'Privacy Policy' }],
    ['shipping-policy', { ar: 'سياسة الشحن', en: 'Shipping Policy' }],
    ['refund-policy', { ar: 'سياسة الاسترجاع', en: 'Refund Policy' }],
    ['about', { ar: 'من نحن', en: 'About us' }],
  ];
  for (const [key, t] of legal) {
    const page = await prisma.page.create({ data: { key } });
    await prisma.pageTranslation.createMany({
      data: [
        { pageId: page.id, locale: 'ar', title: t.ar, content: '<p>سيتم تحديث هذا المحتوى من لوحة التحكم.</p>' },
        { pageId: page.id, locale: 'en', title: t.en, content: '<p>This content is managed from the admin panel.</p>' },
      ],
    });
  }
  console.log('Demo: catalogue, customizer (7 steps), homepage, FAQ and legal pages created');
}

async function main() {
  await seedRbac();
  await seedAdmin();
  await seedShipping();
  if (demo) await seedDemo();
  console.log('Seed finished.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
