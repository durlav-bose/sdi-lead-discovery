import robotsParser from "robots-parser";

type RobotsCacheEntry = { parser: ReturnType<typeof robotsParser>; fetchedAt: number };

const cache = new Map<string, RobotsCacheEntry>();
const TTL_MS = 6 * 60 * 60 * 1000;

function originFromUrl(url: string) {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

export async function canFetch(url: string, userAgent = "SDILeadDiscoveryBot/0.1"): Promise<boolean> {
  try {
    const origin = originFromUrl(url);
    const now = Date.now();
    const cached = cache.get(origin);
    if (cached && now - cached.fetchedAt < TTL_MS) {
      return cached.parser.isAllowed(url, userAgent) ?? false;
    }

    const robotsUrl = `${origin}/robots.txt`;
    const res = await fetch(robotsUrl, { headers: { "User-Agent": userAgent } });
    const txt = res.ok ? await res.text() : "";
    const parser = robotsParser(robotsUrl, txt);
    cache.set(origin, { parser, fetchedAt: now });
    return parser.isAllowed(url, userAgent) ?? false;
  } catch {
    // If robots can't be fetched/parsed, be conservative: only allow homepage.
    const u = new URL(url);
    return u.pathname === "/" || u.pathname === "";
  }
}
