/** Zed-style compact age: 1m, 3h, 4d, 1w, 2mo. */
export function age(ms: number, now = Date.now()): string {
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d`;
  if (s < 30 * 86400) return `${Math.floor(s / (7 * 86400))}w`;
  if (s < 365 * 86400) return `${Math.floor(s / (30 * 86400))}mo`;
  return `${Math.floor(s / (365 * 86400))}y`;
}
