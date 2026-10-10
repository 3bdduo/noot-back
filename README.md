# Notebook Store — Backend

باك اند متجر الدفاتر والمنتجات المكتبية المخصصة (NestJS 12 + Prisma + MongoDB Atlas). العملة **EGP**، اللغات **ar (RTL) / en**، كل المبالغ **قروش (piasters) أعداد صحيحة**، كل التواريخ **UTC**.

> **مهم — حالة التحقق:** هذا الكود كُتب في بيئة لا تستطيع تنزيل حزم npm، لذلك **لم يتم تشغيل `npm install` ولا `tsc` ولا Nest ولا Prisma ضد قاعدة بيانات** قبل التسليم. ما تم فعليًا: فحص syntax لكل ملفات TypeScript (126+ ملف)، فحص أسماء الموديلات والعلاقات المستخدمة مع `schema.prisma`، فحص أن كل كود خطأ له ترجمة عربي/إنجليزي، وتشغيل اختبارات المنطق الصرف (state machine، التسعير، الكوبونات، محرك التخصيص، JWT/TOTP/كلمات المرور، فحص الملفات، التطبيع العربي…). أول `npm install` + `npm run typecheck` على جهازك قد يُظهر بعض أخطاء الأنواع البسيطة — أصلحها (أو ابعتها لي) قبل البدء.

## ما الذي تم تنفيذه

- **Auth**: تسجيل بإيميل/باسورد + تفعيل الإيميل، دخول Google (ID token)، JWT قصير العمر + Refresh Token في `httpOnly` cookie مع rotation وكشف إعادة الاستخدام، قفل الحساب بعد 5 محاولات، نسيان/تغيير كلمة المرور، 2FA (TOTP) للإدارة، الجلسات.
- **RBAC**: 5 أدوار (`customer, admin, staff, content_manager, super_admin`) + مصفوفة صلاحيات قابلة للتعديل، حماية آخر Super Admin، سجل تدقيق (Audit Log) لكل عمليات الإدارة.
- **الكتالوج**: منتجات/متغيرات/تصنيفات/مجموعات (ثنائية اللغة)، بحث عربي مُطبَّع، فلاتر وترتيب، SEO + JSON-LD + breadcrumbs.
- **Customizer (7 خطوات)**: مجموعات خيارات (اختيار واحد/متعدد/نص/تاريخ/ملف) بقواعد تحقق كاملة، "اختياري OR" داخل الخطوة (اسم أو حروف أو رفع تصميم)، تسعير من الخادم فقط، صور طبقات للمعاينة 2D، **Snapshot ثابت** لا يتغير بعد الطلب.
- **السلة**: ضيف (`x-guest-token`) أو مستخدم، إعادة تقييم كل بند عند كل عرض، حفظ لوقت لاحق، كوبونات، رسالة هدية، دمج سلة الضيف عند الدخول.
- **Wishlist + التصاميم المحفوظة**.
- **المخزون**: مخزون للمتغيرات **والمكوّنات**، حجز ذري داخل Transaction مع compare-and-set (لا overselling)، انتهاء الحجز، حدود المخزون المنخفض، تنبيه "نبّهني عند التوفر".
- **الطلبات**: Checkout بـ Idempotency-Key، **State machine** (`PENDING_PAYMENT / COD_PENDING → … → DELIVERED / CANCELLED / REFUNDED`)، Timeline من 9 مراحل، مراجعة التخصيصات (موافقة/طلب تعديل/رفض)، تعديل العنوان/الشخصنة قبل الإنتاج مع حفظ النسخ السابقة، إلغاء مجاني قبل `IN_PRODUCTION`، تتبع للضيوف (رقم الطلب + الإيميل)، شحنات متعددة للطلب مع رقم تتبع يدوي.
- **الدفع عند الاستلام** مع حماية من الطلبات الوهمية (حد أقصى للقيمة، رسوم، أرقام محظورة، حد للطلبات المعلقة لكل رقم).
- **المدفوعات**: جداول Payment/Transaction/Webhook/Refund + `PaymentProvider` interface + Webhook آمن (توقيع على الـ raw body + idempotency) + استردادات. **لا توجد بوابة دفع حقيقية** (Paymob/Fawry/Stripe غير منفذة بقرار منك) — يوجد `mock` للتجربة فقط.
- **الشحن**: مناطق ← محافظات ← أسعار، شحن مجاني فوق حد، تقدير تاريخ التسليم (مدة التصنيع + أيام الشحن).
- **الكوبونات** (نسبة/ثابت، حد أدنى/أقصى، فترة، حد استخدام عام ولكل عميل، منتجات/مجموعات محددة).
- **التقييمات** (مشتريات مُسلَّمة فقط، مراجعة قبل النشر، صور، تجميع التقييم على المنتج).
- **المحتوى (CMS)**: الصفحة الرئيسية، بانرز، مدونة، FAQ، آراء العملاء، صفحات قانونية، Instagram، النشرة البريدية، رسائل التواصل، sitemap/robots.
- **التحليلات** بتوقيت القاهرة، **الإشعارات** (إيميل عبر Resend + داخل التطبيق للإدارة)، **رفع الملفات** (Cloudflare R2، فحص magic bytes، أبعاد، thumbnails، فحص PDF)، **فواتير وأوامر تصنيع HTML قابلة للطباعة**، **Cron** (انتهاء الحجز والدفع، إعادة إرسال الإيميلات، سلات متروكة، عودة المخزون، تنظيف).
- **حساب العميل**: بيانات، عناوين، تصدير بياناتي، حذف الحساب (تجهيل).

## هيكل المشروع

```
notebook-store/
├─ package.json            npm workspaces
├─ packages/shared/        @nb/shared: ثوابت، محافظات، صلاحيات، Zod schemas (مشتركة مع الفرونت)
└─ apps/api/
   ├─ prisma/              schema.prisma, seed.ts, setup-db.ts + schema-indexes.ts (فهارس MongoDB)
   ├─ src/
   │  ├─ common/           guards, filters, crypto, i18n, utils
   │  ├─ config/env.ts     تحقق من المتغيرات (Zod)
   │  └─ modules/          account, admin-users, analytics, audit, auth, cart, catalog, content, coupons,
   │                       customization, health, inventory, jobs, notifications, orders, payments,
   │                       pricing (منطق صرف), reviews, settings, shipping, uploads, wishlist
   ├─ test/                اختبارات vitest للمنطق الصرف
   ├─ api/index.js         Entry لـ Vercel
   └─ vercel.json
```

## التشغيل المحلي

المتطلبات: Node ≥ 22، وحساب **MongoDB Atlas** (الكلاستر المجاني M0 يكفي؛ لازم يكون Replica Set لأن الكود يستخدم Transactions، وAtlas دائمًا كذلك).

```bash
npm install                                  # من جذر المشروع (يعمل prisma generate تلقائيًا)
cp apps/api/.env.example apps/api/.env       # عدّل DATABASE_URL (رابط Atlas), AUTH_SECRET (32+ حرف), SEED_ADMIN_*
npm run build -w @nb/shared                  # مرة واحدة (و بعد أي تعديل في packages/shared)
npm run db:setup                             # ينشئ الـ collections و كل الفهارس في Atlas (آمن للتكرار)
npm run db:seed                              # الأدوار + Super Admin + مناطق الشحن (غير مفعّلة)
npm run dev                                  # http://localhost:4000/api/v1  — Swagger: /api/v1/docs
npm test
npm run typecheck
```

- `SEED_DEMO=true` قبل `db:seed` ينشئ كتالوج تجريبي (خطوات الـ Customizer السبع، منتج مخصص + منتج جاهز، صفحة رئيسية، FAQ، صفحات قانونية) ويفعّل مناطق الشحن.
- بدون `SEED_DEMO` مناطق الشحن تُنشأ **غير مفعّلة**: راجع الأسعار من لوحة التحكم ثم فعّلها، وإلا لن يعمل الـ Checkout (`SHIPPING_NOT_AVAILABLE`).
- **لا تستخدم `prisma db push`** لإنشاء الفهارس: على MongoDB يجعل كل `@unique` فهرسًا عاديًا، والحقول الاختيارية (مثل `Cart.guestToken` و `Order.idempotencyKey`) ستفشل عند وجود أكثر من سجل بدون قيمة. `npm run db:setup` ينشئ فهارس **جزئية** لهذه الحقول (`apps/api/prisma/schema-indexes.ts`)، وشغّله مرة أخرى كلما أضفت `@unique` أو `@@index` في `schema.prisma`.
- في Atlas: Network Access → اسمح بـ IP جهازك، وللنشر على Vercel اسمح بـ `0.0.0.0/0` (Vercel بلا IP ثابت) مع كلمة سر قوية للمستخدم.
- بدون إعداد R2 يُستخدم تخزين محلي للتطوير فقط (`apps/api/.uploads`)، وبدون `EMAIL_API_KEY` تُطبع الإيميلات في الـ console.

## المتغيرات الأساسية (`apps/api/.env`)

راجع `.env.example` للقائمة الكاملة. الأهم: `APP_URL` (رابط الفرونت — يُستخدم في روابط الإيميلات)، `CORS_ORIGINS`، `DATABASE_URL`، `AUTH_SECRET`، `COOKIE_SECURE=true` في الإنتاج، `GOOGLE_CLIENT_ID`، `EMAIL_API_KEY` (Resend) + `EMAIL_FROM`، `STORAGE_*` (R2)، `CRON_SECRET`، `PAYMENT_PROVIDER=none|mock` (الـ mock مرفوض في الإنتاج).

## ملاحظات خاصة بـ MongoDB Atlas

- **المعرّفات** كلها `ObjectId` (نص من 24 حرف hex). أي id غير صالح يصل من العميل يُرجِع `404 NOT_FOUND` (خطأ Prisma `P2023`).
- **Transactions**: الطلب والمخزون والكوبونات تعمل داخل Transactions (تتطلب Replica Set). عند تعارض كتابة متزامن (`P2034`) تُعاد المحاولة تلقائيًا حتى 3 مرات (`PrismaService.tx`).
- **المخزون**: القراءة ثم التحقق ثم الكتابة داخل Transaction، والكتابة compare-and-set على قيم `quantity/reserved` التي قُرئت — فلا يمكن بيع آخر وحدة لشخصين.
- **التحليلات** (`/admin/analytics/*`): مجاميع Prisma + تجميع في الذاكرة على نطاق أقصى 366 يومًا وبحد 100,000 صف لكل استعلام (`MAX_ROWS`). لمتجر بملايين الطلبات انقلها إلى Aggregation Pipelines.
- **بحث الطلبات** في لوحة التحكم: رقم الطلب/الإيميل/الهاتف، واسم المنتج عبر ترجمات المنتج الحالية (MongoDB لا يبحث داخل أعمدة Json).
- **حذف متتالي (Cascade)** تنفذه Prisma على مستوى التطبيق (relationMode = prisma)، لا قاعدة البيانات.
- لا توجد migrations: تغيير الـ schema يعني `prisma generate` + `npm run db:setup` للفهارس الجديدة. بيانات موجودة تحتاج سكريبت ترحيل يدوي عند تغيير شكل حقل.

## Cloudflare R2 (تخزين مجاني)

1. أنشئ Bucket، فعّل Public access (أو Custom domain) وضع رابطه في `STORAGE_PUBLIC_URL` — يُستخدم لصور المنتجات فقط.
2. أنشئ API Token (Object Read & Write) وضع `STORAGE_ACCOUNT_ID / ACCESS_KEY_ID / SECRET_ACCESS_KEY / BUCKET`.
3. **CORS للـ Bucket** (ضروري لأن الرفع من المتصفح مباشرة):
```json
[{ "AllowedOrigins": ["https://your-frontend.com", "http://localhost:3000"],
   "AllowedMethods": ["PUT", "GET", "HEAD"], "AllowedHeaders": ["*"], "MaxAgeSeconds": 3600 }]
```
ملفات تصاميم العملاء **خاصة** (روابط موقّعة 10 دقائق) وتُحفظ للأبد (retention = null من الإعدادات).

## النشر على Vercel (غير مُختبَر)

`vercel.json` و `api/index.js` جاهزين لكنهما **لم يُجرَّبا**. اجعل Root Directory = `apps/api`، وأضف المتغيرات في Vercel. الـ Prisma يحتاج `binaryTargets = ["native","rhel-openssl-3.0.x"]` (مضبوط). ضع رابط Atlas في `DATABASE_URL`، وشغّل `npm run db:setup` من جهازك مرة واحدة (ليس أثناء الـ build). على Vercel يُفضَّل تقليل الاتصالات بإضافة `&maxPoolSize=5` لرابط Atlas. قيود مهمة على Serverless:

- **لا يوجد Redis/Queue**: المهام الخلفية تعمل عبر `GET|POST /api/v1/internal/cron/tick` (Header: `Authorization: Bearer $CRON_SECRET`). Vercel Hobby يسمح بـ Cron يوميًا فقط، لذلك اضبط أيضًا pinger مجاني (cron-job.org) كل 5–10 دقائق على نفس الرابط. حتى بدون Cron: حجز المخزون المنتهي يُحرَّر تلقائيًا عند أي حجز جديد (lazy expiry).
- **Rate limiting داخل الذاكرة** لكل instance (دفاع إضافي فقط) — فعّل Vercel Firewall/Cloudflare للحماية الفعلية. قفل الحساب مخزن في DB فهو صالح.
- حد حجم الـ body على Vercel ≈ 4.5MB → رفع الملفات يتم **مباشرة إلى R2** وليس عبر الـ API.
- عند الانتقال لـ VPS: `npm run build && npm start` + Nginx + PM2؛ لا تعديل مطلوب.

## عقد الفرونت إند (مهم)

**Headers**: `Authorization: Bearer <access>` | `x-guest-token` (زائر غير مسجل؛ تحصل عليه من `POST /cart/session` وتحفظه) | `x-locale: ar|en` | `x-nb-client: web` (إجباري لـ `/auth/refresh` و `/auth/logout`) | `Idempotency-Key` (في `POST /checkout`، قيمة جديدة لكل محاولة).
**Cookies**: `nb_rt` (refresh، httpOnly). أرسل الطلبات بـ `credentials: 'include'`، و `CORS_ORIGINS` يجب أن يحتوي أصل الفرونت بالضبط.
**شكل الخطأ**: `{ "error": { "code": "OUT_OF_STOCK", "message": "<مترجم>", "details": [{ "field", "code", "message" }], "requestId": "…" } }` — اعتمد على `code` وليس `message`.
**Pagination**: `?page=1&pageSize=20` → `{ items, page, pageSize, total, totalPages }`.
**روابط الإيميلات** التي يجب أن يوفّرها الفرونت: `/verify-email?token=`، `/reset-password?token=`، `/track-order?order=`، `/account/orders/:id`، `/cart`، `/products/:slug`، `/checkout/result?order=&status=`.
**الفواتير وأمر التصنيع** تُرجَع HTML: اجلبها بالـ Authorization header ثم افتح الناتج في تبويب جديد للطباعة (`window.open` على blob).

### تدفق الطلب

1. `POST /cart/session` (للزائر) → `POST /cart/items` (مع `customization`) → `GET /cart?governorate=CAI`.
2. `POST /checkout/preview` ثم `POST /checkout` → الرد يحتوي `nextAction`: `AWAIT_CONFIRMATION` (COD) أو `PAY_ONLINE` (→ `POST /orders/:id/pay` يرجع `redirectUrl`، ثم polling على `POST /orders/:id/payment-status`).
3. COD: الإدارة تؤكد (`POST /admin/orders/:id/status` بـ `PAYMENT_CONFIRMED`) → مراجعة التخصيص (إن وُجد) → `IN_PRODUCTION` → `QUALITY_CHECK` → `PACKED` → `POST /admin/orders/:id/ship` → `OUT_FOR_DELIVERY` → `DELIVERED` (يُسجَّل الدفع تلقائيًا للـ COD).

## الصلاحيات

الأدوار الافتراضية قابلة للتعديل من `PUT /admin/roles/:key/permissions`. `staff`: الطلبات + مراجعة التخصيص + الشحن؛ `content_manager`: المحتوى والمجموعات؛ `admin`: كل شيء عدا تعديل الأدوار والإعدادات وسجل التدقيق؛ `super_admin`: كل شيء.

## ما لم يُنفَّذ / قرارات يجب أن تعرفها

- **بوابات الدفع الحقيقية** غير منفذة (Paymob/Fawry/Stripe). لإضافة واحدة: class يطبّق `PaymentProvider` ويُسجَّل في `PaymentsService`، ثم اضبط `PAYMENT_PROVIDER` — بقية التدفق (webhook، تأكيد الطلب، الاسترداد) جاهز. حتى ذلك الحين `CARD/WALLET` تُرفض برسالة `PAYMENT_NOT_AVAILABLE` والمتاح فقط COD.
- **الفاتورة PDF**: مُنفَّذة كـ HTML قابل للطباعة (الطباعة من المتصفح تدعم العربية بشكل صحيح، مكتبات PDF في Node لا تدعمه جيدًا).
- **شركات الشحن**: إدخال رقم تتبع يدوي (`Carrier` interface جاهز لربط API لاحقًا).
- **فحص PDF للأمان** يعتمد على كشف المحتوى النشط الظاهر في الملف (best-effort)، وليس antivirus كامل.
- **المراقبة**: Logs منظمة JSON فقط (بدون Sentry) كما اخترت.
- روابط الـ sitemap تفترض مسارات الفرونت: `/products/:slug`، `/collections/:slug`، `/categories/:slug`، `/journal/:slug`، `/pages/:key` — عدّلها في `ContentService.sitemapEntries` إن اختلفت.
- تعديل الطلب بعد التأكيد مباشر **قبل `IN_PRODUCTION` فقط** (عنوان/نصوص وملفات التخصيص بدون تغيير السعر)؛ بعدها يتواصل العميل مع الدعم.

## كل الـ Endpoints

#### account

| Method | Path | Access |
|---|---|---|
| GET | `/api/v1/account/profile` | مسجّل دخول |
| PATCH | `/api/v1/account/profile` | مسجّل دخول |
| GET | `/api/v1/account/addresses` | مسجّل دخول |
| POST | `/api/v1/account/addresses` | مسجّل دخول |
| PATCH | `/api/v1/account/addresses/:id` | مسجّل دخول |
| DELETE | `/api/v1/account/addresses/:id` | مسجّل دخول |
| POST | `/api/v1/account/export` | مسجّل دخول |
| POST | `/api/v1/account/delete` | مسجّل دخول |

#### admin-users

| Method | Path | Access |
|---|---|---|
| GET | `/api/v1/admin/roles` | صلاحية: roles.read |
| GET | `/api/v1/admin/permissions` | صلاحية: roles.read |
| PUT | `/api/v1/admin/roles/:key/permissions` | صلاحية: roles.update |
| GET | `/api/v1/admin/admins` | صلاحية: admins.read |
| POST | `/api/v1/admin/admins` | صلاحية: admins.create |
| PATCH | `/api/v1/admin/admins/:id` | صلاحية: admins.update |
| DELETE | `/api/v1/admin/admins/:id` | صلاحية: admins.delete |
| POST | `/api/v1/admin/admins/:id/2fa/reset` | صلاحية: roles.update |
| GET | `/api/v1/admin/customers` | صلاحية: customers.read |
| GET | `/api/v1/admin/customers/:id` | صلاحية: customers.read |
| PATCH | `/api/v1/admin/customers/:id/status` | صلاحية: customers.update |

#### analytics

| Method | Path | Access |
|---|---|---|
| GET | `/api/v1/admin/analytics/overview` | مسجّل دخول |
| GET | `/api/v1/admin/analytics/sales-by-day` | مسجّل دخول |
| GET | `/api/v1/admin/analytics/top-products` | مسجّل دخول |
| GET | `/api/v1/admin/analytics/customization-popularity` | مسجّل دخول |
| GET | `/api/v1/admin/analytics/governorates` | مسجّل دخول |
| GET | `/api/v1/admin/analytics/payment-methods` | مسجّل دخول |
| GET | `/api/v1/admin/analytics/coupons` | مسجّل دخول |
| GET | `/api/v1/admin/analytics/operations` | مسجّل دخول |

#### audit

| Method | Path | Access |
|---|---|---|
| GET | `/api/v1/admin/audit-logs` | صلاحية: audit.read |

#### auth

| Method | Path | Access |
|---|---|---|
| POST | `/api/v1/auth/register` | عام |
| POST | `/api/v1/auth/verify-email` | عام |
| POST | `/api/v1/auth/resend-verification` | عام |
| POST | `/api/v1/auth/login` | عام |
| POST | `/api/v1/auth/google` | عام |
| POST | `/api/v1/auth/2fa/verify` | عام |
| POST | `/api/v1/auth/refresh` | عام |
| POST | `/api/v1/auth/logout` | عام |
| POST | `/api/v1/auth/forgot-password` | عام |
| POST | `/api/v1/auth/reset-password` | عام |
| GET | `/api/v1/auth/me` | مسجّل دخول |
| POST | `/api/v1/auth/change-password` | مسجّل دخول |
| POST | `/api/v1/auth/logout-all` | مسجّل دخول |
| GET | `/api/v1/auth/sessions` | مسجّل دخول |
| DELETE | `/api/v1/auth/sessions/:id` | مسجّل دخول |
| POST | `/api/v1/auth/2fa/setup` | مسجّل دخول |
| POST | `/api/v1/auth/2fa/enable` | مسجّل دخول |
| POST | `/api/v1/auth/2fa/disable` | مسجّل دخول |

#### cart

| Method | Path | Access |
|---|---|---|
| POST | `/api/v1/cart/session` | عام |
| GET | `/api/v1/cart` | عام |
| POST | `/api/v1/cart/items` | عام |
| PATCH | `/api/v1/cart/items/:id` | عام |
| DELETE | `/api/v1/cart/items/:id` | عام |
| DELETE | `/api/v1/cart` | عام |
| POST | `/api/v1/cart/coupon` | عام |
| DELETE | `/api/v1/cart/coupon` | عام |
| PUT | `/api/v1/cart/gift` | عام |
| DELETE | `/api/v1/cart/gift` | عام |
| POST | `/api/v1/cart/merge` | مسجّل دخول |

#### catalog

| Method | Path | Access |
|---|---|---|
| GET | `/api/v1/products` | عام |
| GET | `/api/v1/products/:slug` | عام |
| POST | `/api/v1/products/:slug/quote` | عام |
| GET | `/api/v1/categories` | عام |
| GET | `/api/v1/collections` | عام |
| GET | `/api/v1/collections/:slug` | عام |
| GET | `/api/v1/shop/filters` | عام |
| GET | `/api/v1/admin/products` | صلاحية: products.read |
| GET | `/api/v1/admin/products/:id` | صلاحية: products.read |
| POST | `/api/v1/admin/products` | صلاحية: products.create |
| PATCH | `/api/v1/admin/products/:id` | صلاحية: products.update |
| DELETE | `/api/v1/admin/products/:id` | صلاحية: products.delete |
| GET | `/api/v1/admin/categories` | صلاحية: categories.read |
| POST | `/api/v1/admin/categories` | صلاحية: categories.create |
| PATCH | `/api/v1/admin/categories/:id` | صلاحية: categories.update |
| DELETE | `/api/v1/admin/categories/:id` | صلاحية: categories.delete |
| GET | `/api/v1/admin/collections` | صلاحية: collections.read |
| POST | `/api/v1/admin/collections` | صلاحية: collections.create |
| PATCH | `/api/v1/admin/collections/:id` | صلاحية: collections.update |
| DELETE | `/api/v1/admin/collections/:id` | صلاحية: collections.delete |

#### content

| Method | Path | Access |
|---|---|---|
| GET | `/api/v1/content/homepage` | عام |
| GET | `/api/v1/content/banners` | عام |
| GET | `/api/v1/content/testimonials` | عام |
| GET | `/api/v1/content/faq` | عام |
| GET | `/api/v1/content/instagram` | عام |
| GET | `/api/v1/content/pages/:key` | عام |
| GET | `/api/v1/journal` | عام |
| GET | `/api/v1/journal/:slug` | عام |
| POST | `/api/v1/newsletter/subscribe` | عام |
| POST | `/api/v1/newsletter/unsubscribe` | عام |
| POST | `/api/v1/contact` | عام |
| GET | `/api/v1/seo/sitemap.xml` | عام |
| GET | `/api/v1/seo/sitemap.json` | عام |
| GET | `/api/v1/seo/robots.txt` | عام |
| GET | `/api/v1/admin/content/:kind` | صلاحية: content.read |
| GET | `/api/v1/admin/content/:kind/:id` | صلاحية: content.read |
| POST | `/api/v1/admin/content/:kind` | صلاحية: content.create |
| PATCH | `/api/v1/admin/content/:kind/:id` | صلاحية: content.update |
| DELETE | `/api/v1/admin/content/:kind/:id` | صلاحية: content.delete |
| GET | `/api/v1/admin/contact-messages` | صلاحية: content.read |
| PATCH | `/api/v1/admin/contact-messages/:id` | صلاحية: content.update |
| GET | `/api/v1/admin/newsletter` | صلاحية: content.read |

#### coupons

| Method | Path | Access |
|---|---|---|
| GET | `/api/v1/admin/coupons` | صلاحية: coupons.read |
| GET | `/api/v1/admin/coupons/:id` | صلاحية: coupons.read |
| GET | `/api/v1/admin/coupons/:id/usages` | صلاحية: coupons.read |
| POST | `/api/v1/admin/coupons` | صلاحية: coupons.create |
| PATCH | `/api/v1/admin/coupons/:id` | صلاحية: coupons.update |
| DELETE | `/api/v1/admin/coupons/:id` | صلاحية: coupons.delete |

#### customization

| Method | Path | Access |
|---|---|---|
| GET | `/api/v1/products/:slug/customizer` | عام |
| GET | `/api/v1/admin/customization-groups` | صلاحية: customizations.read |
| GET | `/api/v1/admin/customization-groups/:id` | صلاحية: customizations.read |
| POST | `/api/v1/admin/customization-groups` | صلاحية: customizations.create |
| PATCH | `/api/v1/admin/customization-groups/:id` | صلاحية: customizations.update |
| DELETE | `/api/v1/admin/customization-groups/:id` | صلاحية: customizations.delete |
| POST | `/api/v1/admin/customization-groups/:id/options` | صلاحية: customizations.create |
| PATCH | `/api/v1/admin/customization-options/:id` | صلاحية: customizations.update |
| DELETE | `/api/v1/admin/customization-options/:id` | صلاحية: customizations.delete |
| GET | `/api/v1/admin/products/:id/customization-groups` | صلاحية: customizations.read |
| PUT | `/api/v1/admin/products/:id/customization-groups` | صلاحية: customizations.update |

#### health

| Method | Path | Access |
|---|---|---|
| GET | `/api/v1/health` | عام |
| GET | `/api/v1/health/ready` | عام |

#### inventory

| Method | Path | Access |
|---|---|---|
| GET | `/api/v1/admin/inventory` | صلاحية: inventory.read |
| GET | `/api/v1/admin/inventory/:id/movements` | صلاحية: inventory.read |
| POST | `/api/v1/admin/inventory` | صلاحية: inventory.update |
| POST | `/api/v1/admin/inventory/:id/adjust` | صلاحية: inventory.update |
| PATCH | `/api/v1/admin/inventory/:id` | صلاحية: inventory.update |
| POST | `/api/v1/products/:slug/notify-me` | عام |

#### jobs

| Method | Path | Access |
|---|---|---|
| GET | `/api/v1/internal/cron/tick` | عام |
| POST | `/api/v1/internal/cron/tick` | عام |

#### notifications

| Method | Path | Access |
|---|---|---|
| GET | `/api/v1/notifications` | مسجّل دخول |
| POST | `/api/v1/notifications/read` | مسجّل دخول |

#### orders

| Method | Path | Access |
|---|---|---|
| GET | `/api/v1/admin/orders` | صلاحية: orders.read |
| GET | `/api/v1/admin/orders/counts` | صلاحية: orders.read |
| GET | `/api/v1/admin/orders/:id` | صلاحية: orders.read |
| POST | `/api/v1/admin/orders/:id/status` | صلاحية: orders.update |
| POST | `/api/v1/admin/orders/:id/ship` | صلاحية: orders.update |
| POST | `/api/v1/admin/orders/:id/notes` | صلاحية: orders.update |
| POST | `/api/v1/admin/shipments/:id/events` | صلاحية: orders.update |
| GET | `/api/v1/admin/orders/:id/invoice` | صلاحية: orders.read |
| GET | `/api/v1/admin/orders/:id/production-sheet` | صلاحية: orders.read |
| GET | `/api/v1/admin/customizations` | صلاحية: customizations.read |
| GET | `/api/v1/admin/customizations/:itemId` | صلاحية: customizations.read |
| POST | `/api/v1/admin/customizations/:itemId/review` | صلاحية: customizations.review |
| GET | `/api/v1/admin/blocked-phones` | صلاحية: customers.read |
| POST | `/api/v1/admin/blocked-phones` | صلاحية: customers.update |
| DELETE | `/api/v1/admin/blocked-phones/:id` | صلاحية: customers.update |
| POST | `/api/v1/checkout/preview` | عام |
| POST | `/api/v1/checkout` | عام |
| GET | `/api/v1/orders` | مسجّل دخول |
| GET | `/api/v1/orders/:id` | مسجّل دخول |
| POST | `/api/v1/orders/:id/cancel` | مسجّل دخول |
| PATCH | `/api/v1/orders/:id/address` | مسجّل دخول |
| PATCH | `/api/v1/orders/:id/items/:itemId/personalization` | مسجّل دخول |
| GET | `/api/v1/orders/:id/invoice` | مسجّل دخول |
| POST | `/api/v1/track-order` | عام |
| POST | `/api/v1/track-order/cancel` | عام |

#### payments

| Method | Path | Access |
|---|---|---|
| GET | `/api/v1/payments/methods` | عام |
| POST | `/api/v1/orders/:id/pay` | عام |
| POST | `/api/v1/orders/:id/payment-status` | عام |
| POST | `/api/v1/payments/webhooks/:provider` | عام |
| GET | `/api/v1/payments/mock/checkout` | عام |
| GET | `/api/v1/payments/mock/complete` | عام |
| GET | `/api/v1/admin/payments` | صلاحية: payments.read |
| GET | `/api/v1/admin/payments/webhooks` | صلاحية: payments.read |
| GET | `/api/v1/admin/refunds` | صلاحية: payments.read |
| POST | `/api/v1/admin/orders/:id/refunds` | صلاحية: payments.refund |
| POST | `/api/v1/admin/refunds/:id/complete` | صلاحية: payments.refund |
| POST | `/api/v1/admin/refunds/:id/cancel` | صلاحية: payments.refund |

#### reviews

| Method | Path | Access |
|---|---|---|
| GET | `/api/v1/products/:slug/reviews` | عام |
| GET | `/api/v1/account/reviews` | مسجّل دخول |
| GET | `/api/v1/account/reviews/reviewable` | مسجّل دخول |
| POST | `/api/v1/reviews` | مسجّل دخول |
| PATCH | `/api/v1/reviews/:id` | مسجّل دخول |
| DELETE | `/api/v1/reviews/:id` | مسجّل دخول |
| POST | `/api/v1/reviews/images/presign` | مسجّل دخول |
| POST | `/api/v1/reviews/images/complete` | مسجّل دخول |
| GET | `/api/v1/admin/reviews` | صلاحية: reviews.read |
| PATCH | `/api/v1/admin/reviews/:id` | صلاحية: reviews.moderate |
| DELETE | `/api/v1/admin/reviews/:id` | صلاحية: reviews.moderate |

#### settings

| Method | Path | Access |
|---|---|---|
| GET | `/api/v1/settings/public` | عام |
| GET | `/api/v1/admin/settings` | صلاحية: settings.read |
| PUT | `/api/v1/admin/settings/:key` | صلاحية: settings.update |

#### shipping

| Method | Path | Access |
|---|---|---|
| GET | `/api/v1/shipping/governorates` | عام |
| GET | `/api/v1/shipping/quote` | عام |
| GET | `/api/v1/admin/shipping/zones` | صلاحية: shipping.read |
| POST | `/api/v1/admin/shipping/zones` | صلاحية: shipping.update |
| PATCH | `/api/v1/admin/shipping/zones/:id` | صلاحية: shipping.update |
| DELETE | `/api/v1/admin/shipping/zones/:id` | صلاحية: shipping.update |
| PUT | `/api/v1/admin/shipping/zones/:id/governorates` | صلاحية: shipping.update |
| POST | `/api/v1/admin/shipping/zones/:id/rates` | صلاحية: shipping.update |
| PATCH | `/api/v1/admin/shipping/rates/:id` | صلاحية: shipping.update |
| DELETE | `/api/v1/admin/shipping/rates/:id` | صلاحية: shipping.update |

#### uploads

| Method | Path | Access |
|---|---|---|
| POST | `/api/v1/uploads/artwork/presign` | عام |
| POST | `/api/v1/uploads/artwork/:id/complete` | عام |
| GET | `/api/v1/uploads/artwork/:id` | عام |
| DELETE | `/api/v1/uploads/artwork/:id` | عام |
| GET | `/api/v1/admin/artwork/:id` | صلاحية: orders.read + customizations.read |
| POST | `/api/v1/admin/uploads/media/presign` | صلاحية: ...MEDIA_PERMS |
| POST | `/api/v1/admin/uploads/media/complete` | صلاحية: ...MEDIA_PERMS |
| PUT | `/api/v1/uploads/local/put` | عام |
| GET | `/api/v1/uploads/local/get` | عام |

#### wishlist

| Method | Path | Access |
|---|---|---|
| GET | `/api/v1/wishlist` | مسجّل دخول |
| POST | `/api/v1/wishlist/:productId` | مسجّل دخول |
| DELETE | `/api/v1/wishlist/:productId` | مسجّل دخول |
| POST | `/api/v1/wishlist/:productId/move-to-cart` | مسجّل دخول |
| GET | `/api/v1/account/designs` | مسجّل دخول |
| POST | `/api/v1/account/designs` | مسجّل دخول |
| DELETE | `/api/v1/account/designs/:id` | مسجّل دخول |
| POST | `/api/v1/account/designs/:id/add-to-cart` | مسجّل دخول |
"# noot-back" 
