import { Injectable } from '@nestjs/common';
import type { Locale } from '@nb/shared';
import { GOVERNORATES } from '@nb/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AppError } from '../../common/errors/app-error.js';
import { esc } from '../../common/utils/html.js';
import { formatMoney } from '../notifications/email-templates.js';
import { SettingsService } from '../settings/settings.service.js';
import { pickBilingual } from './orders.service.js';

const PAGE_CSS = `
*{box-sizing:border-box}body{font-family:Tahoma,'Segoe UI',Arial,sans-serif;color:#211B18;margin:0;padding:32px;font-size:14px;line-height:1.6}
h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px}
table{width:100%;border-collapse:collapse}th,td{padding:8px;border-bottom:1px solid #e6e1d9;vertical-align:top;text-align:start}th{background:#f5f0e8;font-size:12px}
.meta{display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap}.muted{color:#6b625b}.right{text-align:end}
.totals{margin-inline-start:auto;width:320px}.totals td{border:0;padding:4px 8px}.grand td{font-weight:bold;font-size:16px;border-top:2px solid #211B18}
.box{border:2px solid #211B18;padding:10px 14px;margin:8px 0;border-radius:4px;break-inside:avoid}.big{font-size:20px;font-weight:bold}
.tag{display:inline-block;background:#6E2635;color:#fff;padding:1px 8px;border-radius:3px;font-size:12px}
@media print{body{padding:12px}.noprint{display:none}}
`;

const page = (locale: Locale, title: string, body: string) =>
  `<!doctype html><html lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${PAGE_CSS}</style></head><body>${body}<p class="noprint muted" style="margin-top:32px">Ctrl+P / ⌘P</p></body></html>`;

const govName = (code: string, locale: Locale) => {
  const g = GOVERNORATES.find((x) => x.code === code);
  return g ? (locale === 'ar' ? g.nameAr : g.nameEn) : code;
};

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  private async load(id: string) {
    const order = await this.prisma.order.findFirst({
      where: { OR: [{ id }, { orderNumber: id.toUpperCase() }] },
      include: { items: { orderBy: { createdAt: 'asc' }, include: { selections: true } }, gift: true },
    });
    if (!order) throw AppError.notFound('ORDER_NOT_FOUND');
    return order;
  }

  /** Customer-facing invoice (printable HTML; browsers print Arabic correctly, unlike most PDF libraries). */
  async invoiceHtml(id: string, locale: Locale, ownerUserId?: string): Promise<string> {
    const order = await this.load(id);
    if (ownerUserId && order.userId !== ownerUserId) throw AppError.notFound('ORDER_NOT_FOUND');
    const store = await this.settings.get('store');
    const tax = await this.settings.get('tax');
    const ar = locale === 'ar';
    const t = (a: string, e: string) => (ar ? a : e);
    const a = order.shippingAddress as any;
    const hidePrices = Boolean(order.gift?.hidePrices);
    const m = (n: number) => formatMoney(n, locale);

    const rows = order.items
      .map((it) => {
        const p = it.productSnapshot as any;
        const v = it.variantSnapshot as any;
        const snap = it.customizationSnapshot as any;
        const sum = snap?.selections?.length
          ? `<div class="muted" style="font-size:12px">${snap.selections
              .map((s: any) => esc(`${pickBilingual(s.groupName, locale)}: ${s.textValue ?? s.dateValue ?? pickBilingual(s.optionName, locale) ?? ''}`))
              .join(' · ')}</div>`
          : '';
        return `<tr><td>${esc(pickBilingual(p?.name, locale))}${v?.sku ? `<div class="muted" style="font-size:12px">${esc(v.sku)}</div>` : ''}${sum}</td><td>${it.quantity}</td>${
          hidePrices ? '' : `<td class="right">${m(it.unitPrice)}</td><td class="right">${m(it.totalPrice)}</td>`
        }</tr>`;
      })
      .join('');

    const totals = hidePrices
      ? ''
      : `<table class="totals">
          <tr><td>${t('المجموع الفرعي', 'Subtotal')}</td><td class="right">${m(order.subtotal)}</td></tr>
          ${order.discount ? `<tr><td>${t('الخصم', 'Discount')}${order.couponCode ? ` (${esc(order.couponCode)})` : ''}</td><td class="right">− ${m(order.discount)}</td></tr>` : ''}
          <tr><td>${t('الشحن', 'Shipping')}</td><td class="right">${m(order.shippingFee)}</td></tr>
          ${order.codFee ? `<tr><td>${t('رسوم الدفع عند الاستلام', 'COD fee')}</td><td class="right">${m(order.codFee)}</td></tr>` : ''}
          ${order.tax ? `<tr><td>${esc(tax.label)}${tax.inclusive ? t(' (شامل)', ' (included)') : ''}</td><td class="right">${m(order.tax)}</td></tr>` : ''}
          <tr class="grand"><td>${t('الإجمالي', 'Total')}</td><td class="right">${m(order.total)}</td></tr>
        </table>`;

    const body = `
      <div class="meta"><div><h1>${esc(ar ? store.nameAr : store.nameEn)}</h1><div class="muted">${esc(store.address)}<br>${esc(store.supportEmail)} ${esc(store.supportPhone)}</div></div>
      <div class="right"><h1>${t('فاتورة', 'Invoice')}</h1><div>#${esc(order.orderNumber)}</div><div class="muted">${order.placedAt.toISOString().slice(0, 10)}</div></div></div>
      <h2>${t('بيانات الشحن', 'Ship to')}</h2>
      <div>${esc(`${a.firstName} ${a.lastName}`)}<br>${esc(a.street)}${a.building ? `, ${esc(a.building)}` : ''}${a.apartment ? `, ${esc(a.apartment)}` : ''}<br>${esc(a.city)} - ${esc(govName(order.governorate, locale))}<br>${esc(a.phone)}</div>
      <h2>${t('المنتجات', 'Items')}</h2>
      <table><thead><tr><th>${t('المنتج', 'Product')}</th><th>${t('الكمية', 'Qty')}</th>${hidePrices ? '' : `<th class="right">${t('السعر', 'Price')}</th><th class="right">${t('الإجمالي', 'Total')}</th>`}</tr></thead><tbody>${rows}</tbody></table>
      ${totals}
      <p class="muted">${t('طريقة الدفع', 'Payment')}: ${esc(order.paymentMethod)} — ${esc(order.paymentStatus)}</p>
      ${order.gift ? `<h2>${t('رسالة الهدية', 'Gift message')}</h2><div class="box">${esc(order.gift.message)}${order.gift.senderName ? `<br><span class="muted">— ${esc(order.gift.senderName)}</span>` : ''}</div>` : ''}`;
    return page(locale, `${t('فاتورة', 'Invoice')} ${order.orderNumber}`, body);
  }

  /** Internal production sheet: every personalization value large and unambiguous, for the workshop. */
  async productionSheetHtml(id: string, locale: Locale = 'ar'): Promise<string> {
    const order = await this.load(id);
    const t = (a: string, e: string) => (locale === 'ar' ? a : e);

    const items = order.items
      .map((it, idx) => {
        const p = it.productSnapshot as any;
        const v = it.variantSnapshot as any;
        const sels = it.selections;
        const options = sels.filter((s) => s.groupType === 'SINGLE_CHOICE' || s.groupType === 'MULTI_CHOICE');
        const texts = sels.filter((s) => s.groupType === 'TEXT');
        const dates = sels.filter((s) => s.groupType === 'DATE');
        const files = sels.filter((s) => s.groupType === 'FILE');
        const snap = it.customizationSnapshot as any;
        const nameOf = (code: string) => {
          const s = (snap?.selections ?? []).find((x: any) => x.groupCode === code);
          return pickBilingual(s?.groupName, locale) || code;
        };
        return `<div class="box">
          <div class="big">${idx + 1}. ${esc(pickBilingual(p?.name, locale))} <span class="tag">× ${it.quantity}</span></div>
          <div class="muted">SKU ${esc(v?.sku ?? '')} ${[v?.color, v?.size, v?.paper, v?.material].filter(Boolean).map((x) => esc(String(x))).join(' / ')}</div>
          ${options.length ? `<table><tbody>${options.map((s) => `<tr><th>${esc(nameOf(s.groupCode))}</th><td>${esc(s.nameSnapshot ?? s.optionCode ?? '')}</td></tr>`).join('')}</tbody></table>` : ''}
          ${texts.map((s) => `<h2>${esc(nameOf(s.groupCode))}</h2><div class="big" dir="auto" style="letter-spacing:.02em">${esc(s.textValue ?? '')}</div>`).join('')}
          ${dates.map((s) => `<h2>${esc(nameOf(s.groupCode))}</h2><div class="big">${s.dateValue ? s.dateValue.toISOString().slice(0, 10) : ''}</div>`).join('')}
          ${files.map((s) => `<h2>${esc(nameOf(s.groupCode))}</h2><div>${t('ملف التصميم', 'Artwork file')}: <code>${esc(s.artworkFileId ?? '')}</code> (${t('حمّله من لوحة التحكم', 'download from the admin panel')})</div>`).join('')}
          ${it.customizationReviewStatus ? `<div class="muted">${t('حالة المراجعة', 'Review')}: ${esc(it.customizationReviewStatus)}</div>` : ''}
        </div>`;
      })
      .join('');

    const body = `
      <div class="meta"><div><h1>${t('أمر تصنيع', 'Production sheet')}</h1><div class="big">#${esc(order.orderNumber)}</div></div>
      <div class="right"><div>${t('التاريخ', 'Placed')}: ${order.placedAt.toISOString().slice(0, 10)}</div>
      <div>${t('التسليم المتوقع', 'Due')}: ${order.estimatedDeliveryAt ? order.estimatedDeliveryAt.toISOString().slice(0, 10) : '—'}</div></div></div>
      ${items}
      ${order.gift ? `<div class="box"><b>${t('رسالة هدية — تُطبع وتُرفق', 'Gift message — print and include')}</b><div dir="auto">${esc(order.gift.message)}</div></div>` : ''}
      ${order.customerNote ? `<div class="box"><b>${t('ملاحظة العميل', 'Customer note')}</b><div>${esc(order.customerNote)}</div></div>` : ''}`;
    return page(locale, `${t('أمر تصنيع', 'Production')} ${order.orderNumber}`, body);
  }
}
