export const LOCALES = ['ar', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'ar';
export const CURRENCY = 'EGP';

export const ORDER_STATUSES = [
  'PENDING_PAYMENT',
  'COD_PENDING',
  'PAYMENT_CONFIRMED',
  'CUSTOMIZATION_REVIEW',
  'CUSTOMIZATION_APPROVED',
  'IN_PRODUCTION',
  'QUALITY_CHECK',
  'PACKED',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
  'REFUND_REQUESTED',
  'REFUNDED',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const PAYMENT_STATUSES = [
  'PENDING',
  'COD_PENDING',
  'AUTHORIZED',
  'PAID',
  'FAILED',
  'CANCELLED',
  'REFUND_PENDING',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const PAYMENT_METHODS = ['CARD', 'WALLET', 'COD'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const CUSTOMIZATION_REVIEW_STATUSES = [
  'PENDING_REVIEW',
  'APPROVED',
  'NEEDS_CHANGES',
  'REJECTED',
  'SENT_TO_PRODUCTION',
] as const;
export type CustomizationReviewStatus = (typeof CUSTOMIZATION_REVIEW_STATUSES)[number];

/** The 9 customer-facing timeline stages. */
export const TIMELINE_STAGES = [
  'PLACED',
  'PAYMENT_CONFIRMED',
  'CUSTOMIZATION_REVIEW',
  'IN_PRODUCTION',
  'QUALITY_CHECK',
  'PACKED',
  'SHIPPED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
] as const;
export type TimelineStage = (typeof TIMELINE_STAGES)[number];

export const CUSTOMIZATION_GROUP_TYPES = ['SINGLE_CHOICE', 'MULTI_CHOICE', 'TEXT', 'DATE', 'FILE'] as const;
export type CustomizationGroupType = (typeof CUSTOMIZATION_GROUP_TYPES)[number];

export const TEXT_CHARSETS = ['ARABIC', 'LATIN', 'DIGITS', 'SYMBOLS', 'SPACE'] as const;
export type TextCharset = (typeof TEXT_CHARSETS)[number];

export const ALLOWED_ARTWORK_MIME_TYPES = ['image/png', 'image/jpeg', 'application/pdf'] as const;

/** Order statuses in which the customer may still cancel / edit personalization. */
export const PRE_PRODUCTION_STATUSES: readonly OrderStatus[] = [
  'PENDING_PAYMENT',
  'COD_PENDING',
  'PAYMENT_CONFIRMED',
  'CUSTOMIZATION_REVIEW',
  'CUSTOMIZATION_APPROVED',
];
