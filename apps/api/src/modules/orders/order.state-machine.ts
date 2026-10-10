/**
 * Order state machine — PURE (no Nest, no DB). Every status change in the system goes through `assertTransition`.
 *
 *   online : PENDING_PAYMENT ─paid→ PAYMENT_CONFIRMED
 *   COD    : COD_PENDING ─admin confirms→ PAYMENT_CONFIRMED   (payment stays COD_PENDING until delivery)
 *   then   : [CUSTOMIZATION_REVIEW → CUSTOMIZATION_APPROVED →] IN_PRODUCTION → QUALITY_CHECK → PACKED
 *            → SHIPPED → OUT_FOR_DELIVERY → DELIVERED
 *   exits  : CANCELLED (before shipping), REFUND_REQUESTED → REFUNDED
 */
import { PRE_PRODUCTION_STATUSES, TIMELINE_STAGES } from '@nb/shared';
import type { OrderStatus, TimelineStage } from '@nb/shared';

export type TransitionActor = 'customer' | 'admin' | 'system';

export interface TransitionContext {
  hasCustomization: boolean;
  actor: TransitionActor;
  paymentStatus?: string;
}

const BASE: Record<OrderStatus, OrderStatus[]> = {
  PENDING_PAYMENT: ['PAYMENT_CONFIRMED', 'CANCELLED'],
  COD_PENDING: ['PAYMENT_CONFIRMED', 'CANCELLED'],
  PAYMENT_CONFIRMED: ['CUSTOMIZATION_REVIEW', 'IN_PRODUCTION', 'PACKED', 'CANCELLED'],
  CUSTOMIZATION_REVIEW: ['CUSTOMIZATION_APPROVED', 'CANCELLED'],
  CUSTOMIZATION_APPROVED: ['IN_PRODUCTION', 'CUSTOMIZATION_REVIEW', 'CANCELLED'],
  IN_PRODUCTION: ['QUALITY_CHECK', 'CANCELLED'],
  QUALITY_CHECK: ['PACKED', 'IN_PRODUCTION', 'CANCELLED'],
  PACKED: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['OUT_FOR_DELIVERY', 'DELIVERED', 'REFUND_REQUESTED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'SHIPPED', 'REFUND_REQUESTED'],
  DELIVERED: ['REFUND_REQUESTED'],
  CANCELLED: ['REFUND_REQUESTED'],
  REFUND_REQUESTED: ['REFUNDED', 'DELIVERED', 'CANCELLED'],
  REFUNDED: [],
};

/** Statuses a CUSTOMER may cancel from: before production starts (free cancellation window). */
export const CUSTOMER_CANCELLABLE: readonly OrderStatus[] = PRE_PRODUCTION_STATUSES;

/** Statuses in which the customer may edit address / personalization directly. */
export const CUSTOMER_EDITABLE: readonly OrderStatus[] = PRE_PRODUCTION_STATUSES;

export function allowedTargets(from: OrderStatus, ctx: TransitionContext): OrderStatus[] {
  let targets = [...BASE[from]];

  // Personalised orders must be reviewed before production.
  if (from === 'PAYMENT_CONFIRMED') {
    targets = ctx.hasCustomization
      ? targets.filter((t) => t === 'CUSTOMIZATION_REVIEW' || t === 'CANCELLED')
      : targets.filter((t) => t !== 'CUSTOMIZATION_REVIEW');
  }
  // A cancelled order can only go to refund when money was actually collected.
  if (from === 'CANCELLED' && ctx.paymentStatus !== 'PAID' && ctx.paymentStatus !== 'PARTIALLY_REFUNDED') {
    targets = targets.filter((t) => t !== 'REFUND_REQUESTED');
  }
  if (ctx.actor === 'customer') {
    // Customers can only cancel (within the window) or request a refund after delivery.
    targets = targets.filter((t) => (t === 'CANCELLED' && CUSTOMER_CANCELLABLE.includes(from)) || t === 'REFUND_REQUESTED');
    if (from !== 'DELIVERED') targets = targets.filter((t) => t !== 'REFUND_REQUESTED');
  }
  return targets;
}

export function canTransition(from: OrderStatus, to: OrderStatus, ctx: TransitionContext): boolean {
  return allowedTargets(from, ctx).includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`Invalid order transition ${from} -> ${to}`);
  }
}

export function assertTransition(from: OrderStatus, to: OrderStatus, ctx: TransitionContext): void {
  if (!canTransition(from, to, ctx)) throw new InvalidTransitionError(from, to);
}

export const TERMINAL_STATUSES: readonly OrderStatus[] = ['REFUNDED'];

/** Order is "open": stock is still committed and nothing final has happened. */
export function isCancellable(status: OrderStatus, actor: TransitionActor): boolean {
  return actor === 'customer' ? CUSTOMER_CANCELLABLE.includes(status) : BASE[status].includes('CANCELLED');
}

// ------------------------------------------------------------------------------------ customer timeline

export interface TimelineStep {
  stage: TimelineStage;
  state: 'done' | 'current' | 'upcoming' | 'skipped';
  at: Date | null;
}

const STAGE_OF: Partial<Record<OrderStatus, TimelineStage>> = {
  PENDING_PAYMENT: 'PLACED',
  COD_PENDING: 'PLACED',
  PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
  CUSTOMIZATION_REVIEW: 'CUSTOMIZATION_REVIEW',
  CUSTOMIZATION_APPROVED: 'CUSTOMIZATION_REVIEW',
  IN_PRODUCTION: 'IN_PRODUCTION',
  QUALITY_CHECK: 'QUALITY_CHECK',
  PACKED: 'PACKED',
  SHIPPED: 'SHIPPED',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
};

export interface HistoryEntry {
  toStatus: OrderStatus;
  createdAt: Date;
}

/**
 * Maps the status history onto the 9 customer-facing stages.
 * Orders without personalization show the review stage as "skipped".
 * Cancelled / refunded orders freeze the timeline at the last reached stage.
 */
export function buildTimeline(args: { status: OrderStatus; hasCustomization: boolean; placedAt: Date; history: HistoryEntry[] }): TimelineStep[] {
  const reachedAt = new Map<TimelineStage, Date>([['PLACED', args.placedAt]]);
  let lastReached: TimelineStage = 'PLACED';
  for (const h of [...args.history].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
    const stage = STAGE_OF[h.toStatus];
    if (!stage) continue;
    if (!reachedAt.has(stage)) reachedAt.set(stage, h.createdAt);
    if (TIMELINE_STAGES.indexOf(stage) > TIMELINE_STAGES.indexOf(lastReached)) lastReached = stage;
  }
  const currentStage = STAGE_OF[args.status] ?? lastReached;
  const frozen = args.status === 'CANCELLED' || args.status === 'REFUND_REQUESTED' || args.status === 'REFUNDED';
  const currentIdx = TIMELINE_STAGES.indexOf(frozen ? lastReached : currentStage);

  return TIMELINE_STAGES.map((stage, idx): TimelineStep => {
    if (stage === 'CUSTOMIZATION_REVIEW' && !args.hasCustomization) return { stage, state: 'skipped', at: null };
    const at = reachedAt.get(stage) ?? null;
    if (idx < currentIdx) return { stage, state: 'done', at };
    if (idx === currentIdx) {
      const finished = args.status === 'DELIVERED' && stage === 'DELIVERED';
      return { stage, state: finished ? 'done' : frozen ? 'done' : 'current', at };
    }
    return { stage, state: 'upcoming', at: null };
  });
}

/** What an operator can do next (drives the admin UI buttons). */
export function nextAdminActions(status: OrderStatus, ctx: Omit<TransitionContext, 'actor'>): OrderStatus[] {
  return allowedTargets(status, { ...ctx, actor: 'admin' });
}
