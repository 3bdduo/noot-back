/** All money is INTEGER piasters. */
export function egp(piasters: number): string {
  return (piasters / 100).toFixed(2);
}

export function percentOf(amount: number, basisPoints: number): number {
  return Math.round((amount * basisPoints) / 10_000);
}

export function clampInt(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(n)));
}
