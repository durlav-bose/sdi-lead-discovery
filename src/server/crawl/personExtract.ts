
import * as cheerio from "cheerio";

type PersonCandidate = {
  name: string;
  role?: string;
  email?: string;
  emailEvidence?: string;
  phone?: string;
  phoneEvidence?: string;
  confidence?: number;
  evidenceJson?: any;
};

function norm(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

const NAME_BLACKLIST_RE = /\b(cancel|logout|login|sign\s*in|sign\s*out|register|username|password|remember|cookie|cookies|einstellungen|settings|privacy|datenschutz|impressum|online|termin|termine|buchen|booking|anrufen|call|menu|navigation|like|share|follow)\b/i;

const EMAIL_INLINE_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/i;
const PHONE_INLINE_RE = /(\+?\d[\d\s().-]{7,}\d)/;

function isGenericMailboxEmail(email: string) {
  const e = norm(email).toLowerCase();
  const at = e.indexOf("@");
  if (at < 1) return true;
  const local = e.slice(0, at);
  return /^(info|kontakt|contact|office|admin|mail|hello|team|service|support|marketing|sales|booking|termin|appointment|praxis|empfang)$/.test(local);
}

function splitJoinedWords(raw: string) {
  // Insert spaces in cases like "ZahnarztMario" or "PraxismanagerinMelanie"
  return norm(raw).replace(/([a-zà-öø-ÿ])([A-ZÀ-ÖØ-Ý])/g, "$1 $2");
}

function stripRolePrefixesFromName(raw: string) {
  let t = splitJoinedWords(raw);
  // remove common role prefixes at the start of the string
  t = t.replace(/^\s*(zahnarzt|zahnärztin|dentist|praxismanagerin|praxismanager|dr\.?|prof\.?|dres\.?)\s+/i, "");
  return norm(t);
}

function normalizeRole(rawRole: string, name?: string) {
  let r = splitJoinedWords(rawRole);
  const n = name ? norm(name).toLowerCase() : "";
  if (n) {
    const rn = r.toLowerCase();
    if (rn.includes(n)) {
      // Remove the name from the role line
      r = norm(rn.replace(n, " "));
    }
  }

  const lower = r.toLowerCase();
  if (/praxismanagerin/.test(lower)) return "Praxismanagerin";
  if (/praxismanager\b/.test(lower)) return "Praxismanager";
  if (/praxisinhaberin/.test(lower)) return "Praxisinhaberin";
  if (/praxisinhaber\b/.test(lower)) return "Praxisinhaber";
  if (/zahnärztin/.test(lower)) return "Zahnärztin";
  if (/zahnarzt\b/.test(lower)) return "Zahnarzt";
  if (/dentist/.test(lower)) return "Dentist";

  return norm(r).slice(0, 120);
}

function stripTitles(raw: string) {
  let t = splitJoinedWords(raw);
  t = t.replace(/\b(dr\.?|prof\.?|dres\.?|mr\.?|mrs\.?|ms\.?|herr|frau)\b/gi, " ");
  t = t.replace(/\b(med\.?|med\.\s*dent\.?|dent\.?|msc\.?|phd|mba)\b/gi, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function hasDentalTitle(raw: string) {
  const t = norm(raw).toLowerCase();
  return /\bdr\b/.test(t) && (/med\./.test(t) || /dent/.test(t));
}

function hasRepeatedWordPattern(raw: string) {
  const parts = norm(raw).split(" ").filter(Boolean);
  if (parts.length < 2) return false;
  const lower = parts.map((p) => p.toLowerCase());
  const uniq = new Set(lower);
  return uniq.size === 1;
}

function isLikelyName(s: string) {
  const t = stripTitles(s);
  if (t.length < 5 || t.length > 80) return false;
  if (/[@]|https?:\/\//i.test(t)) return false;
  if (NAME_BLACKLIST_RE.test(t)) return false;
  if (hasRepeatedWordPattern(t)) return false;
  const parts = t.split(" ").filter(Boolean);
  if (parts.length < 2 || parts.length > 5) return false;
  if (parts.some((p) => p.length < 2)) return false;
  const uniqueParts = new Set(parts.map((p) => p.toLowerCase()));
  if (uniqueParts.size <= 1) return false;
  if (!parts.every((p) => /^[A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ'’-]+$/.test(p))) return false;
  return true;
}

function roleScore(role?: string) {
  if (!role) return 0;
  const r = role.toLowerCase();
  if (/ceo|chief executive|geschäftsführer|managing director|owner|inhaber|founder|co-?founder|partner|director|president/.test(r)) return 40;
  if (/praxisinhaber|praxisinhaberin|zahnarzt|zahnärztin|dentist/.test(r)) return 35;
  if (/head|lead|manager|leitung/.test(r)) return 20;
  return 10;
}

function nameScore(name: string) {
  return isLikelyName(name) ? 25 : 0;
}

function safeUrl(u: string, baseUrl: string) {
  try {
    return new URL(u, baseUrl).toString();
  } catch {
    return "";
  }
}

export function extractPersons(html: string, baseUrl: string): PersonCandidate[] {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe").remove();

  const candidates: PersonCandidate[] = [];
  const seen = new Set<string>();

  // ---- JSON-LD (schema.org) ----
  try {
    const scripts = $("script[type='application/ld+json']").toArray().slice(0, 20);
    for (const s of scripts) {
      const raw = String($(s).text() ?? "").trim();
      if (!raw) continue;
      const parsed = JSON.parse(raw);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const n of nodes) {
        const graph = Array.isArray(n?.['@graph']) ? n['@graph'] : [];
        const all = [...(graph.length ? graph : []), n];
        for (const item of all) {
          const t = String(item?.['@type'] ?? "");
          if (!/person/i.test(t)) continue;
          const nameRaw = String(item?.name ?? "").trim();
          const emailRaw = String(item?.email ?? "").replace(/^mailto:/i, "").trim().toLowerCase();
          if (!nameRaw || !isLikelyName(nameRaw)) continue;
          if (!emailRaw || isGenericMailboxEmail(emailRaw)) continue;
          const name = stripRolePrefixesFromName(stripTitles(nameRaw));
          const role = item?.jobTitle ? normalizeRole(String(item.jobTitle), name) : undefined;

          const key = `${name.toLowerCase()}|${(role ?? "").toLowerCase()}|${emailRaw}|`;
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({
            name,
            role,
            email: emailRaw,
            emailEvidence: baseUrl,
            confidence: Math.min(100, nameScore(name) + roleScore(role) + 20),
            evidenceJson: { baseUrl, source: "jsonld" }
          });
        }
      }
    }
  } catch {
    // ignore JSON-LD parse errors
  }

  const roleKeywords = /(ceo|chief executive|geschäftsführer|managing director|owner|inhaber|inhaberin|praxisinhaber|praxisinhaberin|zahnarzt|zahnärztin|dentist|founder|co-?founder|partner|director|president|head|manager|leitung|praxismanager|praxismanagerin)/i;

  const elements = $("a, p, li, div, section, article, header, footer, td, th")
    .toArray()
    .slice(0, 2500);

  for (const el of elements) {
    const txt = norm($(el).text());
    if (!txt) continue;

    let name: string | undefined;
    let role: string | undefined;

    const lines = txt.split(/\n|\r/).map(norm).filter(Boolean);
    for (const line of lines.slice(0, 6)) {
      if (!name && isLikelyName(line)) {
        name = stripRolePrefixesFromName(stripTitles(line));
        if (!role && hasDentalTitle(line)) role = "Zahnarzt";
      }
      if (!role && roleKeywords.test(line)) role = normalizeRole(line, name);
    }

    if (!name) continue;

    let email: string | undefined;
    let phone: string | undefined;
    let emailEvidence: string | undefined;
    let phoneEvidence: string | undefined;

    const mailto = $(el).is("a[href^='mailto:']") ? $(el) : $(el).find("a[href^='mailto:']").first();
    if (mailto.length) {
      const href = norm(String(mailto.attr("href") ?? ""));
      const m = href.match(/^mailto:([^?]+)/i);
      if (m?.[1]) {
        const candidate = m[1].trim().toLowerCase();
        if (!isGenericMailboxEmail(candidate)) {
          email = candidate;
          emailEvidence = safeUrl(String(mailto.attr("href") ?? ""), baseUrl) || baseUrl;
        }
      }
    }

    const tel = $(el).is("a[href^='tel:']") ? $(el) : $(el).find("a[href^='tel:']").first();
    if (tel.length) {
      const href = norm(String(tel.attr("href") ?? ""));
      const m = href.match(/^tel:([^?]+)/i);
      if (m?.[1]) {
        phone = norm(m[1]);
        phoneEvidence = safeUrl(String(tel.attr("href") ?? ""), baseUrl) || baseUrl;
      }
    }

    // If not found directly, search in a larger surrounding container (common on team pages/cards)
    if (!email || !phone) {
      const container = $(el).closest("tr, td, th, li, article, section, div");
      const containerTxt = norm(container.text());

      if (!email) {
        const a = container.find("a[href^='mailto:']").first();
        if (a.length) {
          const href = norm(String(a.attr("href") ?? ""));
          const m = href.match(/^mailto:([^?]+)/i);
          if (m?.[1]) {
            const candidate = m[1].trim().toLowerCase();
            if (!isGenericMailboxEmail(candidate)) {
              email = candidate;
              emailEvidence = safeUrl(String(a.attr("href") ?? ""), baseUrl) || baseUrl;
            }
          }
        }
      }
      if (!phone) {
        const a = container.find("a[href^='tel:']").first();
        if (a.length) {
          const href = norm(String(a.attr("href") ?? ""));
          const m = href.match(/^tel:([^?]+)/i);
          if (m?.[1]) {
            phone = norm(m[1]);
            phoneEvidence = safeUrl(String(a.attr("href") ?? ""), baseUrl) || baseUrl;
          }
        }
      }

      if (!email) {
        const m = containerTxt.match(EMAIL_INLINE_RE);
        if (m?.[0]) {
          const candidate = m[0].trim().toLowerCase();
          if (!isGenericMailboxEmail(candidate)) {
            email = candidate;
            emailEvidence = baseUrl;
          }
        }
      }
      if (!phone) {
        const m = containerTxt.match(PHONE_INLINE_RE);
        if (m?.[1]) {
          phone = norm(m[1]);
          phoneEvidence = baseUrl;
        }
      }
    }

    // Fallback: if we have a name but no linked contact, try to extract inline contact from same block
    if (!email) {
      const m = txt.match(EMAIL_INLINE_RE);
      if (m?.[0]) {
        const candidate = m[0].trim().toLowerCase();
        if (!isGenericMailboxEmail(candidate)) {
          email = candidate;
          emailEvidence = baseUrl;
        }
      }
    }
    if (!phone) {
      const m = txt.match(PHONE_INLINE_RE);
      if (m?.[1]) {
        phone = norm(m[1]);
        phoneEvidence = baseUrl;
      }
    }

    const key = `${name.toLowerCase()}|${(role ?? "").toLowerCase()}|${(email ?? "").toLowerCase()}|${(phone ?? "").toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const conf = Math.min(100, nameScore(name) + roleScore(role) + (email ? 20 : 0) + (phone ? 15 : 0));
    candidates.push({
      name,
      role,
      email,
      emailEvidence,
      phone,
      phoneEvidence,
      confidence: conf,
      evidenceJson: { baseUrl, text: txt.slice(0, 400) }
    });
  }

  return candidates
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, 10);
}

