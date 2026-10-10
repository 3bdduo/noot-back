/** Pure stock rules shared by catalog, cart and checkout. */
export interface StockLike {
  quantity: number;
  reserved: number;
  trackInventory: boolean;
  allowBackorder: boolean;
  lowStockThreshold?: number;
}

export function availableOf(inv: Pick<StockLike, 'quantity' | 'reserved'>): number {
  return Math.max(0, inv.quantity - inv.reserved);
}

/** A variant/option without an inventory row is treated as "not tracked" (always purchasable). */
export function isPurchasable(inv: StockLike | null | undefined, qty = 1): boolean {
  if (!inv) return true;
  if (!inv.trackInventory || inv.allowBackorder) return true;
  return availableOf(inv) >= qty;
}

export function isLowStock(inv: StockLike | null | undefined): boolean {
  if (!inv || !inv.trackInventory) return false;
  const available = availableOf(inv);
  return available > 0 && available <= (inv.lowStockThreshold ?? 5);
}

/** What the storefront shows: exact remaining quantity only when it is low, otherwise null. */
export function publicRemaining(inv: StockLike | null | undefined): number | null {
  return isLowStock(inv) ? availableOf(inv!) : null;
}
