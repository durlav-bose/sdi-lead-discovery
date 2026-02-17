import { CandidateCompany } from "../types";

const BLOCKED_HOSTS = new Set([
  "facebook.com", "instagram.com", "linkedin.com", "x.com", "twitter.com",
  "youtube.com", "tiktok.com", "pinterest.com", "maps.google.com"
]);

function cleanHost(h: string) {
  return h.replace(/^www\./, "").toLowerCase();
}

function isHttpUrl(u: string) {
  return u.startsWith("http://") || u.startsWith("https://");
}

function extractHrefs(html: string) {
  const out: string[] = [];
  const re = /href\s*=\s*"([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push(m[1]);
  }
  const re2 = /href\s*=\s*'([^']+)'/gi;
  while ((m = re2.exec(html))) {
    out.push(m[1]);
  }
  return out;
}

function absolutize(base: string, href: string) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export async function expandCandidatesFromSeeds(params: {
  seeds: string[];
  limit: number;
  address_country?: string;
}): Promise<CandidateCompany[]> {
  const { seeds, limit } = params;
  const country = params.address_country ?? "CH";

  const seedHosts = new Set(seeds.map((s) => cleanHost(new URL(s).hostname)));

  const found: CandidateCompany[] = [];
  const seenHosts = new Set<string>();

  for (const seed of seeds) {
    if (found.length >= limit) break;

    let html = "";
    try {
      const res = await fetch(seed, { redirect: "follow" });
      if (!res.ok) continue;
      html = await res.text();
    } catch {
      continue;
    }

    for (const href of extractHrefs(html)) {
      if (found.length >= limit) break;
      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) continue;
      const abs = absolutize(seed, href);
      if (!abs || !isHttpUrl(abs)) continue;

      let host = "";
      try {
        host = cleanHost(new URL(abs).hostname);
      } catch {
        continue;
      }

      // only external domains (directory -> company websites)
      const seedHost = cleanHost(new URL(seed).hostname);
      if (host === seedHost) continue;

      // block socials / noise
      if ([...BLOCKED_HOSTS].some((b) => host === b || host.endsWith("." + b))) continue;

      // avoid re-adding the directory host itself, and duplicates
      if (seedHosts.has(host)) continue;
      if (seenHosts.has(host)) continue;

      seenHosts.add(host);

      found.push({
        company_name: "",
        company_website: "https://" + host,
        address_country: country
      });
    }
  }

  return found.slice(0, limit);
}
