import type { Locale } from '@nb/shared';
import { esc } from '../../common/utils/html.js';
import { env } from '../../config/env.js';

export const NOTIFICATION_EVENTS = [
  'welcome',
  'verify_email',
  'reset_password',
  'password_changed',
  'order_confirmation',
  'payment_confirmed',
  'customization_approved',
  'customization_changes',
  'production_started',
  'order_shipped',
  'order_delivered',
  'order_cancelled',
  'refund_confirmed',
  'abandoned_cart',
  'back_in_stock',
  // admin in-app only
  'admin_new_order',
  'admin_customization_pending',
  'admin_low_stock',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export type TemplateData = Record<string, any>;

export interface RenderedMessage {
  subject: string;
  /** Short plain text used for the in-app notification body and the text/plain email part. */
  lines: string[];
  html: string;
  text: string;
}

interface Copy {
  subject: string;
  heading: string;
  lines: string[];
  cta?: { label: string; url?: string };
}

export function formatMoney(piasters: number | undefined | null, locale: Locale): string {
  const value = ((piasters ?? 0) / 100).toFixed(2);
  return locale === 'ar' ? `${value} ج.م` : `EGP ${value}`;
}

const brand = () => env.BRAND_NAME;

function url(path: string): string {
  return `${env.APP_URL.replace(/\/$/, '')}${path}`;
}

/** Content per event and language. Every interpolated value is escaped later in the layout. */
function copyFor(event: NotificationEvent, locale: Locale, d: TemplateData): Copy {
  const ar = locale === 'ar';
  const name = d.name ? String(d.name) : ar ? 'عميلنا العزيز' : 'there';
  const order = d.orderNumber ? String(d.orderNumber) : '';
  const trackUrl = d.trackUrl ? String(d.trackUrl) : order ? url(`/track-order?order=${encodeURIComponent(order)}`) : url('/');

  switch (event) {
    case 'welcome':
      return ar
        ? { subject: `أهلاً بك في ${brand()}`, heading: `أهلاً ${name}`, lines: ['يسعدنا انضمامك إلينا. صمّم دفترك الخاص واستمتع بتجربة فاخرة.'], cta: { label: 'ابدأ التصميم', url: url('/build') } }
        : { subject: `Welcome to ${brand()}`, heading: `Welcome, ${name}`, lines: ['We are delighted to have you. Design your own notebook and enjoy a premium experience.'], cta: { label: 'Start designing', url: url('/build') } };
    case 'verify_email':
      return ar
        ? { subject: 'فعّل بريدك الإلكتروني', heading: `مرحباً ${name}`, lines: ['اضغط على الزر التالي لتفعيل حسابك. الرابط صالح لمدة 24 ساعة.'], cta: { label: 'تفعيل الحساب', url: d.url } }
        : { subject: 'Verify your email address', heading: `Hi ${name}`, lines: ['Click the button below to activate your account. The link is valid for 24 hours.'], cta: { label: 'Verify email', url: d.url } };
    case 'reset_password':
      return ar
        ? { subject: 'إعادة تعيين كلمة المرور', heading: `مرحباً ${name}`, lines: ['وصلنا طلب لإعادة تعيين كلمة المرور. الرابط صالح لمدة ساعة. إذا لم تطلب ذلك فتجاهل هذه الرسالة.'], cta: { label: 'تعيين كلمة مرور جديدة', url: d.url } }
        : { subject: 'Reset your password', heading: `Hi ${name}`, lines: ['We received a request to reset your password. The link is valid for one hour. If this was not you, ignore this email.'], cta: { label: 'Set a new password', url: d.url } };
    case 'password_changed':
      return ar
        ? { subject: 'تم تغيير كلمة المرور', heading: `مرحباً ${name}`, lines: ['تم تغيير كلمة مرور حسابك. إن لم تكن أنت، تواصل معنا فوراً.'] }
        : { subject: 'Your password was changed', heading: `Hi ${name}`, lines: ['Your account password was changed. If this was not you, contact us immediately.'] };
    case 'order_confirmation':
      return ar
        ? { subject: `تم استلام طلبك #${order}`, heading: `شكراً ${name}`, lines: [`استلمنا طلبك رقم ${order} بإجمالي ${formatMoney(d.total, 'ar')}.`, d.paymentMethod === 'COD' ? 'سنتواصل معك لتأكيد الطلب قبل التجهيز.' : 'سنبدأ التجهيز فور تأكيد الدفع.'], cta: { label: 'تتبع الطلب', url: trackUrl } }
        : { subject: `We received your order #${order}`, heading: `Thank you, ${name}`, lines: [`We received your order ${order} totalling ${formatMoney(d.total, 'en')}.`, d.paymentMethod === 'COD' ? 'We will contact you to confirm the order before preparing it.' : 'We will start preparing it as soon as payment is confirmed.'], cta: { label: 'Track order', url: trackUrl } };
    case 'payment_confirmed':
      return ar
        ? { subject: `تم تأكيد طلبك #${order}`, heading: `تم التأكيد ✓`, lines: [`تم تأكيد طلبك رقم ${order}. ${d.hasCustomization ? 'سيقوم فريقنا بمراجعة التخصيص قبل بدء الإنتاج.' : 'جاري تجهيزه الآن.'}`], cta: { label: 'تتبع الطلب', url: trackUrl } }
        : { subject: `Your order #${order} is confirmed`, heading: 'Confirmed ✓', lines: [`Your order ${order} is confirmed. ${d.hasCustomization ? 'Our team will review your customization before production starts.' : 'We are preparing it now.'}`], cta: { label: 'Track order', url: trackUrl } };
    case 'customization_approved':
      return ar
        ? { subject: `تمت الموافقة على تصميمك #${order}`, heading: 'تمت الموافقة على التخصيص', lines: [`وافقنا على تخصيص طلبك رقم ${order} وسيدخل الإنتاج قريباً.`], cta: { label: 'تتبع الطلب', url: trackUrl } }
        : { subject: `Your design was approved #${order}`, heading: 'Customization approved', lines: [`We approved the customization of order ${order}. It will enter production soon.`], cta: { label: 'Track order', url: trackUrl } };
    case 'customization_changes':
      return ar
        ? { subject: `مطلوب تعديل على تصميمك #${order}`, heading: 'نحتاج تعديلاً بسيطاً', lines: [`نحتاج تعديلاً على تخصيص طلبك رقم ${order}.`, d.note ? `ملاحظات الفريق: ${d.note}` : ''].filter(Boolean), cta: { label: 'عدّل التخصيص', url: d.editUrl ?? trackUrl } }
        : { subject: `Changes needed on your design #${order}`, heading: 'A small change is needed', lines: [`We need a change on the customization of order ${order}.`, d.note ? `Team note: ${d.note}` : ''].filter(Boolean), cta: { label: 'Update customization', url: d.editUrl ?? trackUrl } };
    case 'production_started':
      return ar
        ? { subject: `بدأنا تصنيع طلبك #${order}`, heading: 'طلبك قيد الإنتاج', lines: [`بدأ فريقنا تصنيع طلبك رقم ${order} بكل عناية.`], cta: { label: 'تتبع الطلب', url: trackUrl } }
        : { subject: `Production started #${order}`, heading: 'Your order is in production', lines: [`Our team has started crafting order ${order} with care.`], cta: { label: 'Track order', url: trackUrl } };
    case 'order_shipped':
      return ar
        ? { subject: `تم شحن طلبك #${order}`, heading: 'طلبك في الطريق', lines: [`تم شحن طلبك رقم ${order}.`, d.trackingNumber ? `رقم التتبع: ${d.trackingNumber}${d.carrier ? ` (${d.carrier})` : ''}` : ''].filter(Boolean), cta: { label: 'تتبع الطلب', url: d.trackingUrl ?? trackUrl } }
        : { subject: `Your order #${order} has shipped`, heading: 'On its way', lines: [`Order ${order} has been shipped.`, d.trackingNumber ? `Tracking number: ${d.trackingNumber}${d.carrier ? ` (${d.carrier})` : ''}` : ''].filter(Boolean), cta: { label: 'Track order', url: d.trackingUrl ?? trackUrl } };
    case 'order_delivered':
      return ar
        ? { subject: `تم تسليم طلبك #${order}`, heading: 'تم التسليم', lines: [`نتمنى أن ينال دفترك إعجابك! يمكنك الآن تقييم المنتجات.`], cta: { label: 'قيّم تجربتك', url: url('/account/orders') } }
        : { subject: `Order #${order} delivered`, heading: 'Delivered', lines: ['We hope you love your notebook! You can now review your products.'], cta: { label: 'Rate your experience', url: url('/account/orders') } };
    case 'order_cancelled':
      return ar
        ? { subject: `تم إلغاء الطلب #${order}`, heading: 'تم إلغاء الطلب', lines: [`تم إلغاء طلبك رقم ${order}.`, d.refundPending ? 'سيتم رد المبلغ المدفوع وسنخبرك عند اكتمال العملية.' : ''].filter(Boolean) }
        : { subject: `Order #${order} cancelled`, heading: 'Order cancelled', lines: [`Your order ${order} was cancelled.`, d.refundPending ? 'Your payment will be refunded and we will let you know once it is done.' : ''].filter(Boolean) };
    case 'refund_confirmed':
      return ar
        ? { subject: `تم رد المبلغ #${order}`, heading: 'تم الاسترداد', lines: [`تم رد مبلغ ${formatMoney(d.amount, 'ar')} الخاص بطلبك رقم ${order}.`] }
        : { subject: `Refund processed #${order}`, heading: 'Refund processed', lines: [`A refund of ${formatMoney(d.amount, 'en')} for order ${order} has been processed.`] };
    case 'abandoned_cart':
      return ar
        ? { subject: 'دفترك ينتظرك', heading: `${name}، نسيت شيئاً؟`, lines: ['ما زالت منتجاتك في السلة. أكمل طلبك قبل نفاد الكمية.'], cta: { label: 'العودة إلى السلة', url: url('/cart') } }
        : { subject: 'Your notebook is waiting', heading: `${name}, forgot something?`, lines: ['Your items are still in your cart. Complete your order before they sell out.'], cta: { label: 'Back to cart', url: url('/cart') } };
    case 'back_in_stock':
      return ar
        ? { subject: `${d.productName ?? 'المنتج'} متوفر الآن`, heading: 'عاد للمخزون', lines: [`المنتج الذي كنت تنتظره (${d.productName ?? ''}) أصبح متوفراً.`], cta: { label: 'شاهد المنتج', url: d.productUrl ?? url('/shop') } }
        : { subject: `${d.productName ?? 'Product'} is back in stock`, heading: 'Back in stock', lines: [`The product you were waiting for (${d.productName ?? ''}) is available again.`], cta: { label: 'View product', url: d.productUrl ?? url('/shop') } };
    case 'admin_new_order':
      return ar
        ? { subject: `طلب جديد #${order}`, heading: 'طلب جديد', lines: [`وصل طلب جديد رقم ${order} بقيمة ${formatMoney(d.total, 'ar')}.`] }
        : { subject: `New order #${order}`, heading: 'New order', lines: [`New order ${order} worth ${formatMoney(d.total, 'en')}.`] };
    case 'admin_customization_pending':
      return ar
        ? { subject: `تخصيص بانتظار المراجعة #${order}`, heading: 'تخصيص للمراجعة', lines: [`الطلب ${order} يحتوي على تخصيص بانتظار المراجعة.`] }
        : { subject: `Customization awaiting review #${order}`, heading: 'Customization to review', lines: [`Order ${order} has a customization awaiting review.`] };
    case 'admin_low_stock':
      return ar
        ? { subject: `مخزون منخفض: ${d.sku ?? ''}`, heading: 'مخزون منخفض', lines: [`المتاح من ${d.sku ?? ''} أصبح ${d.available ?? 0} فقط.`] }
        : { subject: `Low stock: ${d.sku ?? ''}`, heading: 'Low stock', lines: [`Only ${d.available ?? 0} left of ${d.sku ?? ''}.`] };
  }
}

export function renderMessage(event: NotificationEvent, locale: Locale, data: TemplateData): RenderedMessage {
  const copy = copyFor(event, locale, data);
  const dir = locale === 'ar' ? 'rtl' : 'ltr';
  const align = locale === 'ar' ? 'right' : 'left';
  const font = locale === 'ar' ? "Tahoma, 'Segoe UI', Arial, sans-serif" : "'Helvetica Neue', Helvetica, Arial, sans-serif";
  const ctaUrl = copy.cta?.url ? String(copy.cta.url) : undefined;
  const safeCtaUrl = ctaUrl && /^https?:\/\//i.test(ctaUrl) ? ctaUrl : undefined;

  const paragraphs = copy.lines.map((l) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.7;color:#211B18">${esc(l)}</p>`).join('');
  const button = safeCtaUrl && copy.cta
    ? `<p style="margin:24px 0 8px"><a href="${esc(safeCtaUrl)}" style="background:#6E2635;color:#F5F0E8;padding:12px 26px;border-radius:4px;text-decoration:none;font-size:15px;display:inline-block">${esc(copy.cta.label)}</a></p>`
    : '';

  const html = `<!doctype html><html lang="${locale}" dir="${dir}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(copy.subject)}</title></head>
<body style="margin:0;padding:0;background:#F5F0E8;font-family:${font}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F0E8;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:6px;overflow:hidden">
<tr><td style="background:#211B18;color:#C7A875;padding:18px 28px;font-size:18px;letter-spacing:1px;text-align:${align}">${esc(brand())}</td></tr>
<tr><td style="padding:28px;text-align:${align}" dir="${dir}">
<h1 style="margin:0 0 16px;font-size:22px;color:#6E2635;font-weight:600">${esc(copy.heading)}</h1>
${paragraphs}${button}
</td></tr>
<tr><td style="padding:16px 28px;background:#F5F0E8;color:#7a6f68;font-size:12px;text-align:${align}">${esc(brand())} · ${esc(env.BRAND_DOMAIN)}</td></tr>
</table></td></tr></table></body></html>`;

  const text = [copy.heading, '', ...copy.lines, safeCtaUrl ? `\n${copy.cta!.label}: ${safeCtaUrl}` : ''].join('\n');
  return { subject: copy.subject, lines: [copy.heading, ...copy.lines], html, text };
}
