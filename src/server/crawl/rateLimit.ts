const lastHitByHost = new Map<string, number>();

export async function rateLimit(url: string, minDelayMs = 2000) {
  const host = new URL(url).host;
  const now = Date.now();
  const last = lastHitByHost.get(host) ?? 0;
  const wait = Math.max(0, minDelayMs - (now - last));
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  lastHitByHost.set(host, Date.now());
}
