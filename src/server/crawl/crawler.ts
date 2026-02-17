import * as cheerio from "cheerio";
import { extractPersons } from "./personExtract";
import { canFetch } from "./robots";
import { env } from "@/lib/env";
import pdfParse from "pdf-parse";

const EMAIL_RE =
  /[A-Z0-9._%+-]+(?:\s*\(at\)\s*|\s*\[at\]\s*|\s*@\s*)[A-Z0-9.-]+(?:\s*\(dot\)\s*|\s*\[dot\]\s*|\s*\.\s*)[A-Z]{2,24}/gi;
const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/g;

export type ExtractedValue = { value: string; snippet: string };

export type ExtractedContact = {
  emails: ExtractedValue[];
  phones: ExtractedValue[];
  hasContactForm?: { value: boolean; snippet?: string };
  hasBookingCalendar?: { value: boolean; snippet?: string };
  techHints: ExtractedValue[];
  decisionMakers: ReturnType<typeof extractPersons>;
};

export type CrawlEvidenceItem = {
  field: string;
  source_url: string;
  snippet: string;
  retrieved_at: string;
};

export type CrawlResult = {
  pages: { url: string; status?: number; contentType?: string }[];
  signals: {
    emails: string[];
    phones: string[];
    hasContactForm?: boolean;
    hasBookingCalendar?: boolean;
    techHints: string[];
    decisionMakers: ReturnType<typeof extractPersons>;
  };
  evidence: CrawlEvidenceItem[];
};

const TECH_PATTERNS: Array<{ key: string; re: RegExp }> = [
  { key: "shopify", re: /cdn\.shopify\.com|myshopify\.com|\bshopify\b/i },
  { key: "wordpress", re: /wp-content|wp-includes|\bwordpress\b/i },
  { key: "wix", re: /wixstatic\.com|\bwix\.com\b/i },
  { key: "squarespace", re: /static1\.squarespace\.com|\bsquarespace\b/i },
  { key: "webflow", re: /\bwebflow\b|data-wf-page/i },
  { key: "jimdo", re: /\bjimdo\b/i }
];

function nowIso() {
  return new Date().toISOString();
}

function uniqKeepOrderStr(arr: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of arr) {
    const v = (a ?? "").trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function safeUrl(u: string, base: string) {
  try {
    return new URL(u, base).toString();
  } catch {
    return "";
  }
}

function sameOrigin(a: string, b: string) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host === ub.host;
  } catch {
    return false;
  }
}

function isGenericMailboxEmail(email: string) {
  const e = String(email ?? "").trim().toLowerCase();
  const at = e.indexOf("@");
  if (at < 1) return true;
  const local = e.slice(0, at);
  return /^(info|kontakt|contact|office|admin|mail|hello|team|service|support|marketing|sales|booking|termin|appointment|praxis|empfang)$/.test(
    local
  );
}

function isLikelyNameLoose(raw: string) {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (s.length < 5 || s.length > 80) return false;
  if (/@|https?:\/\//i.test(s)) return false;
  const cleaned = s
    .replace(/\b(dr\.?|prof\.?|dres\.?|mr\.?|mrs\.?|ms\.?|herr|frau)\b/gi, " ")
    .replace(/\b(med\.?|med\.\s*dent\.?|dent\.?|msc\.?|phd|mba)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length < 2 || parts.length > 5) return false;
  if (parts.some((p) => p.length < 2)) return false;
  // allow diacritics, apostrophes, hyphens
  if (!parts.every((p) => /^[A-ZÀ-ÖØ-Ý][A-Za-zÀ-ÖØ-öø-ÿ'’-]+$/.test(p))) return false;
  return true;
}

function safeUrlMaybe(u: string, base: string) {
  try {
    return new URL(u, base).toString();
  } catch {
    return "";
  }
}

function pickDocumentLinks(html: string, baseUrl: string) {
  const $ = cheerio.load(html);
  const out: { vcards: string[]; pdfs: string[] } = { vcards: [], pdfs: [] };
  $("a[href]").each((_, a) => {
    const href = String($(a).attr("href") ?? "").trim();
    if (!href) return;
    if (/^(mailto:|tel:|javascript:)/i.test(href)) return;
    const abs = safeUrlMaybe(href, baseUrl);
    if (!abs) return;
    if (!sameOrigin(abs, baseUrl)) return;
    const path = new URL(abs).pathname.toLowerCase();
    if (path.endsWith(".vcf")) out.vcards.push(abs);
    if (path.endsWith(".pdf")) out.pdfs.push(abs);
  });
  return {
    vcards: uniqKeepOrderStr(out.vcards),
    pdfs: uniqKeepOrderStr(out.pdfs)
  };
}

async function fetchBinary(url: string, userAgent: string, timeoutMs: number) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": userAgent,
        Accept: "*/*"
      }
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok) return { ok: false, status: res.status, contentType, bytes: Buffer.from("") };
    const ab = await res.arrayBuffer();
    const bytes = Buffer.from(ab);
    return { ok: true, status: res.status, contentType, bytes };
  } catch {
    return { ok: false, status: undefined as any, contentType: "", bytes: Buffer.from("") };
  } finally {
    clearTimeout(t);
  }
}

function parseVcardsToDecisionMakers(vcfText: string, sourceUrl: string) {
  const raw = String(vcfText ?? "");
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const cards: string[][] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (/^BEGIN:VCARD/i.test(l)) {
      cur = [l];
      continue;
    }
    if (cur.length) cur.push(l);
    if (/^END:VCARD/i.test(l) && cur.length) {
      cards.push(cur);
      cur = [];
    }
  }

  const candidates: any[] = [];
  for (const c of cards.slice(0, 12)) {
    let name = "";
    let role: string | undefined;
    const emails: string[] = [];

    for (const l of c) {
      const up = l.toUpperCase();
      if (up.startsWith("FN")) {
        const idx = l.indexOf(":");
        if (idx >= 0) name = l.slice(idx + 1).trim();
      }
      if (up.startsWith("TITLE")) {
        const idx = l.indexOf(":");
        if (idx >= 0) role = l.slice(idx + 1).trim();
      }
      if (up.startsWith("EMAIL")) {
        const idx = l.indexOf(":");
        if (idx >= 0) {
          const e = l.slice(idx + 1).trim().toLowerCase();
          if (e.includes("@") && !isGenericMailboxEmail(e)) emails.push(e);
        }
      }
    }

    name = String(name ?? "").replace(/\s+/g, " ").trim();
    if (!name || !isLikelyNameLoose(name)) continue;
    for (const e of uniqKeepOrderStr(emails).slice(0, 3)) {
      candidates.push({
        name,
        role,
        email: e,
        emailEvidence: sourceUrl,
        confidence: 92,
        evidenceJson: { baseUrl: sourceUrl, source: "vcard" }
      });
    }
  }
  return candidates;
}

function extractDecisionMakersFromPdfText(pdfText: string, sourceUrl: string) {
  const txt = String(pdfText ?? "");
  const lines = txt
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 2500);

  const EMAIL_INLINE_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/i;
  const candidates: any[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(EMAIL_INLINE_RE);
    if (!m?.[0]) continue;
    const email = m[0].toLowerCase();
    if (isGenericMailboxEmail(email)) continue;

    // try to find a plausible name near the email (same line or previous lines)
    const ctx: string[] = [line, lines[i - 1] ?? "", lines[i - 2] ?? ""];
    let name = "";
    for (const c of ctx) {
      const parts = c
        .replace(email, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (isLikelyNameLoose(parts)) {
        name = parts;
        break;
      }
    }
    if (!name) continue;

    const key = `${name.toLowerCase()}|${email}`;
    if (seen.has(key)) continue;
    seen.add(key);

    candidates.push({
      name,
      email,
      emailEvidence: sourceUrl,
      confidence: 85,
      evidenceJson: { baseUrl: sourceUrl, source: "pdf" }
    });
  }

  return candidates.slice(0, 10);
}

async function fetchHtml(url: string, userAgent: string, timeoutMs: number) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml"
      }
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok) return { ok: false, status: res.status, contentType, html: "" };
    if (!contentType.toLowerCase().includes("text/html")) {
      return { ok: false, status: res.status, contentType, html: "" };
    }
    const html = await res.text();
    return { ok: true, status: res.status, contentType, html };
  } catch {
    return { ok: false, status: undefined as any, contentType: "", html: "" };
  } finally {
    clearTimeout(t);
  }
}

function pickNextLinks(html: string, baseUrl: string, limit = 10) {
  const $ = cheerio.load(html);
  const links: string[] = [];
  $("a[href]").each((_, a) => {
    const href = String($(a).attr("href") ?? "").trim();
    if (!href) return;
    if (href.startsWith("#")) return;
    if (/^(mailto:|tel:|javascript:)/i.test(href)) return;
    const abs = safeUrl(href, baseUrl);
    if (!abs) return;
    links.push(abs);
  });

  // Prioritize pages likely to contain contact and management info
  const scored = links
    .filter((u) => sameOrigin(u, baseUrl))
    .map((u) => {
      const p = new URL(u).pathname.toLowerCase();
      const score =
        (/(team|about|ueber|über|kontakt|contact|impressum|management|people|staff|unternehmen)/.test(p) ? 50 : 0) +
        (/(privacy|terms|jobs|career|karriere)/.test(p) ? -20 : 0);
      return { u, score };
    })
    .sort((a, b) => b.score - a.score);

  const picked: string[] = [];
  const seen = new Set<string>();
  for (const s of scored) {
    if (seen.has(s.u)) continue;
    seen.add(s.u);
    picked.push(s.u);
    if (picked.length >= limit) break;
  }
  return picked;
}

export async function crawlCompanyWebsite(params: {
  website: string;
  runId: string;
  maxPages?: number;
  fetchTimeoutMs?: number;
}): Promise<CrawlResult> {
  const maxPages = Math.max(1, Math.min(30, params.maxPages ?? env.CRAWL_MAX_PAGES));
  const fetchTimeoutMs = Math.max(1000, Math.min(60000, params.fetchTimeoutMs ?? env.CRAWL_FETCH_TIMEOUT_MS));
  const userAgent = "SDILeadDiscoveryBot/0.1";
  const startUrl = safeUrl(params.website, params.website) || params.website;

  const queue: string[] = [startUrl];
  const visited = new Set<string>();

  const pages: { url: string; status?: number; contentType?: string }[] = [];
  const evidence: CrawlEvidenceItem[] = [];

  const allEmails: string[] = [];
  const allPhones: string[] = [];
  const allTech: string[] = [];
  let anyContactForm = false;
  let anyBooking = false;
  const allDecisionMakers: any[] = [];

  const vcardQueue: string[] = [];
  const pdfQueue: string[] = [];

  while (queue.length && visited.size < maxPages) {
    const url = queue.shift() as string;
    if (!url) continue;
    if (visited.has(url)) continue;
    visited.add(url);

    const allowed = await canFetch(url, userAgent);
    if (!allowed) continue;

    const fetched = await fetchHtml(url, userAgent, fetchTimeoutMs);
    pages.push({ url, status: fetched.status, contentType: fetched.contentType });
    if (!fetched.ok || !fetched.html) continue;

    // Pick vCard/PDF document links for later processing
    const docs = pickDocumentLinks(fetched.html, url);
    for (const v of docs.vcards.slice(0, 3)) {
      if (vcardQueue.length < 6 && !visited.has(v)) vcardQueue.push(v);
    }
    for (const p of docs.pdfs.slice(0, 3)) {
      if (pdfQueue.length < 6 && !visited.has(p)) pdfQueue.push(p);
    }

    const signals = extractSignals(fetched.html, url);

    for (const e of signals.emails ?? []) {
      allEmails.push(e.value);
      evidence.push({ field: "company_email", source_url: url, snippet: e.snippet, retrieved_at: nowIso() });
    }
    for (const p of signals.phones ?? []) {
      allPhones.push(p.value);
      evidence.push({ field: "company_phone", source_url: url, snippet: p.snippet, retrieved_at: nowIso() });
    }

    if (signals.hasContactForm?.value) {
      anyContactForm = true;
      evidence.push({ field: "has_contact_form", source_url: url, snippet: signals.hasContactForm.snippet ?? "form detected", retrieved_at: nowIso() });
    }
    if (signals.hasBookingCalendar?.value) {
      anyBooking = true;
      evidence.push({ field: "has_booking_calendar", source_url: url, snippet: signals.hasBookingCalendar.snippet ?? "booking detected", retrieved_at: nowIso() });
    }

    for (const t of signals.techHints ?? []) {
      allTech.push(t.value);
      evidence.push({ field: "tech_stack_hints", source_url: url, snippet: t.snippet, retrieved_at: nowIso() });
    }

    if (Array.isArray(signals.decisionMakers)) {
      for (const dm of signals.decisionMakers as any[]) {
        allDecisionMakers.push(dm);
        if (dm?.emailEvidence) {
          evidence.push({ field: "decision_maker_email", source_url: String(dm.emailEvidence), snippet: dm.email ?? "", retrieved_at: nowIso() });
        }
        if (dm?.phoneEvidence) {
          evidence.push({ field: "decision_maker_phone", source_url: String(dm.phoneEvidence), snippet: dm.phone ?? "", retrieved_at: nowIso() });
        }
      }
    }

    const nextLinks = pickNextLinks(fetched.html, url, 10);
    for (const l of nextLinks) {
      if (visited.has(l)) continue;
      if (queue.length + visited.size >= maxPages) break;
      queue.push(l);
    }
  }

  // ---- Process vCard/PDF documents discovered during crawl ----
  const docTimeoutMs = Math.max(1500, Math.min(15000, Math.floor(fetchTimeoutMs * 0.8)));
  const docUrls = uniqKeepOrderStr([...vcardQueue, ...pdfQueue]).slice(0, 10);
  for (const docUrl of docUrls) {
    if (!docUrl) continue;
    const allowed = await canFetch(docUrl, userAgent);
    if (!allowed) continue;

    const fetched = await fetchBinary(docUrl, userAgent, docTimeoutMs);
    pages.push({ url: docUrl, status: fetched.status, contentType: fetched.contentType });
    if (!fetched.ok || !fetched.bytes?.length) continue;

    const lowerPath = (() => {
      try {
        return new URL(docUrl).pathname.toLowerCase();
      } catch {
        return docUrl.toLowerCase();
      }
    })();

    if (lowerPath.endsWith(".vcf") || (fetched.contentType || "").toLowerCase().includes("text/vcard")) {
      const vcfText = fetched.bytes.toString("utf-8");
      const dms = parseVcardsToDecisionMakers(vcfText, docUrl);
      for (const dm of dms) {
        allDecisionMakers.push(dm);
        if (dm?.emailEvidence) {
          evidence.push({ field: "decision_maker_email", source_url: String(dm.emailEvidence), snippet: dm.email ?? "", retrieved_at: nowIso() });
        }
      }
      continue;
    }

    if (lowerPath.endsWith(".pdf") || (fetched.contentType || "").toLowerCase().includes("pdf")) {
      try {
        const parsed = await pdfParse(fetched.bytes);
        const pdfText = String(parsed?.text ?? "");
        const dms = extractDecisionMakersFromPdfText(pdfText, docUrl);
        for (const dm of dms) {
          allDecisionMakers.push(dm);
          if (dm?.emailEvidence) {
            evidence.push({ field: "decision_maker_email", source_url: String(dm.emailEvidence), snippet: dm.email ?? "", retrieved_at: nowIso() });
          }
        }
      } catch {
        // ignore pdf parsing errors
      }
    }
  }

  return {
    pages,
    signals: {
      emails: uniqKeepOrderStr(allEmails).slice(0, 12),
      phones: uniqKeepOrderStr(allPhones).slice(0, 10),
      hasContactForm: anyContactForm,
      hasBookingCalendar: anyBooking,
      techHints: uniqKeepOrderStr(allTech).slice(0, 12),
      decisionMakers: (allDecisionMakers as any[])
        .sort((a, b) => (b?.confidence ?? 0) - (a?.confidence ?? 0))
        .slice(0, 10)
    },
    evidence
  };
}

export async function crawlUrlList(params: {
  urls: string[];
  runId: string;
  fetchTimeoutMs?: number;
  maxUrls?: number;
}): Promise<CrawlResult> {
  const fetchTimeoutMs = Math.max(1000, Math.min(60000, params.fetchTimeoutMs ?? env.CRAWL_FETCH_TIMEOUT_MS));
  const maxUrls = Math.max(0, Math.min(30, params.maxUrls ?? 8));
  const userAgent = "SDILeadDiscoveryBot/0.1";

  const pages: { url: string; status?: number; contentType?: string }[] = [];
  const evidence: CrawlEvidenceItem[] = [];

  const allEmails: string[] = [];
  const allPhones: string[] = [];
  const allTech: string[] = [];
  let anyContactForm = false;
  let anyBooking = false;
  const allDecisionMakers: any[] = [];

  const vcardQueue: string[] = [];
  const pdfQueue: string[] = [];

  const urls = uniqKeepOrderStr(params.urls ?? []).slice(0, maxUrls);
  for (const url of urls) {
    if (!url) continue;
    const allowed = await canFetch(url, userAgent);
    if (!allowed) continue;

    const fetched = await fetchHtml(url, userAgent, fetchTimeoutMs);
    pages.push({ url, status: fetched.status, contentType: fetched.contentType });
    if (!fetched.ok || !fetched.html) continue;

    const docs = pickDocumentLinks(fetched.html, url);
    for (const v of docs.vcards.slice(0, 2)) {
      if (vcardQueue.length < 6) vcardQueue.push(v);
    }
    for (const p of docs.pdfs.slice(0, 2)) {
      if (pdfQueue.length < 6) pdfQueue.push(p);
    }

    const signals = extractSignals(fetched.html, url);

    for (const e of signals.emails ?? []) {
      allEmails.push(e.value);
      evidence.push({ field: "company_email", source_url: url, snippet: e.snippet, retrieved_at: nowIso() });
    }
    for (const p of signals.phones ?? []) {
      allPhones.push(p.value);
      evidence.push({ field: "company_phone", source_url: url, snippet: p.snippet, retrieved_at: nowIso() });
    }

    if (signals.hasContactForm?.value) {
      anyContactForm = true;
      evidence.push({
        field: "has_contact_form",
        source_url: url,
        snippet: signals.hasContactForm.snippet ?? "form detected",
        retrieved_at: nowIso()
      });
    }
    if (signals.hasBookingCalendar?.value) {
      anyBooking = true;
      evidence.push({
        field: "has_booking_calendar",
        source_url: url,
        snippet: signals.hasBookingCalendar.snippet ?? "booking detected",
        retrieved_at: nowIso()
      });
    }

    for (const t of signals.techHints ?? []) {
      allTech.push(t.value);
      evidence.push({ field: "tech_stack_hints", source_url: url, snippet: t.snippet, retrieved_at: nowIso() });
    }

    if (Array.isArray(signals.decisionMakers)) {
      for (const dm of signals.decisionMakers as any[]) {
        allDecisionMakers.push(dm);
        if (dm?.emailEvidence) {
          evidence.push({ field: "decision_maker_email", source_url: String(dm.emailEvidence), snippet: dm.email ?? "", retrieved_at: nowIso() });
        }
        if (dm?.phoneEvidence) {
          evidence.push({ field: "decision_maker_phone", source_url: String(dm.phoneEvidence), snippet: dm.phone ?? "", retrieved_at: nowIso() });
        }
      }
    }
  }

  // documents discovered on extra source pages
  const docTimeoutMs = Math.max(1500, Math.min(15000, Math.floor(fetchTimeoutMs * 0.8)));
  const docUrls = uniqKeepOrderStr([...vcardQueue, ...pdfQueue]).slice(0, 10);
  for (const docUrl of docUrls) {
    if (!docUrl) continue;
    const allowed = await canFetch(docUrl, userAgent);
    if (!allowed) continue;

    const fetched = await fetchBinary(docUrl, userAgent, docTimeoutMs);
    pages.push({ url: docUrl, status: fetched.status, contentType: fetched.contentType });
    if (!fetched.ok || !fetched.bytes?.length) continue;

    const lowerPath = (() => {
      try {
        return new URL(docUrl).pathname.toLowerCase();
      } catch {
        return docUrl.toLowerCase();
      }
    })();

    if (lowerPath.endsWith(".vcf") || (fetched.contentType || "").toLowerCase().includes("text/vcard")) {
      const vcfText = fetched.bytes.toString("utf-8");
      const dms = parseVcardsToDecisionMakers(vcfText, docUrl);
      for (const dm of dms) {
        allDecisionMakers.push(dm);
        if (dm?.emailEvidence) {
          evidence.push({ field: "decision_maker_email", source_url: String(dm.emailEvidence), snippet: dm.email ?? "", retrieved_at: nowIso() });
        }
      }
      continue;
    }

    if (lowerPath.endsWith(".pdf") || (fetched.contentType || "").toLowerCase().includes("pdf")) {
      try {
        const parsed = await pdfParse(fetched.bytes);
        const pdfText = String(parsed?.text ?? "");
        const dms = extractDecisionMakersFromPdfText(pdfText, docUrl);
        for (const dm of dms) {
          allDecisionMakers.push(dm);
          if (dm?.emailEvidence) {
            evidence.push({ field: "decision_maker_email", source_url: String(dm.emailEvidence), snippet: dm.email ?? "", retrieved_at: nowIso() });
          }
        }
      } catch {
        // ignore pdf parsing errors
      }
    }
  }

  return {
    pages,
    signals: {
      emails: uniqKeepOrderStr(allEmails).slice(0, 12),
      phones: uniqKeepOrderStr(allPhones).slice(0, 10),
      hasContactForm: anyContactForm,
      hasBookingCalendar: anyBooking,
      techHints: uniqKeepOrderStr(allTech).slice(0, 12),
      decisionMakers: (allDecisionMakers as any[])
        .sort((a, b) => (b?.confidence ?? 0) - (a?.confidence ?? 0))
        .slice(0, 10)
    },
    evidence
  };
}

const BOOKING_PATTERNS: RegExp[] = [
  /calendly\.com/i,
  /simplybook\.me/i,
  /onedoc\.ch/i,
  /doctena/i,
  /docplanner/i,
  /\btermin\b|\bappointment\b|\bbooking\b/i
];

function uniqKeepOrder(arr: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of arr) {
    const v = a.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function normalizeEmail(raw: string): string {
  return raw
    .trim()
    .replace(/\s*\(at\)\s*/gi, "@")
    .replace(/\s*\[at\]\s*/gi, "@")
    .replace(/\s*\(dot\)\s*/gi, ".")
    .replace(/\s*\[dot\]\s*/gi, ".")
    .replace(/^mailto:/i, "")
    .split("?")[0]
    .replace(/[)\],;:]+$/g, "")
    .toLowerCase();
}

function normalizePhone(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function isLikelyPhone(raw: string): boolean {
  const s = normalizePhone(raw);
  if (!s) return false;
  if (/\b(19\d{2}|20\d{2})\s*[-–]\s*(19\d{2}|20\d{2})\b/.test(s)) return false;

  const digits = s.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return false;
  if (/\b\d{16,}\b/.test(digits)) return false;
  return true;
}

function snippetAround(haystack: string, needle: string, maxLen = 140): string {
  const idx = haystack.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return needle;
  const start = Math.max(0, idx - 50);
  const end = Math.min(haystack.length, idx + needle.length + 50);
  let s = haystack.slice(start, end).replace(/\s+/g, " ").trim();
  if (s.length > maxLen) s = s.slice(0, maxLen) + "…";
  return s;
}

function extractEmailsFromString(s: string): ExtractedValue[] {
  const matches = s.match(EMAIL_RE) ?? [];
  const emails = uniqKeepOrder(matches.map(normalizeEmail));
  return emails.map((e) => ({ value: e, snippet: snippetAround(s, e) }));
}

/**
 * Main site‑content extractor
 */
export function extractSignals(html: string, baseUrl: string): ExtractedContact {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe").remove();
  $("br").replaceWith("\n");
  $("p,div,li,section,article,header,footer,table,tr").each((_, el) => {
    $(el).prepend("\n").append("\n");
  });

  const visibleText = $("body").text().replace(/\u00a0/g, " ");
  const htmlText = $.root().html() ?? "";

  // ---- EMAILS ----
  const mailtoEmails: string[] = [];
  $("a[href^='mailto:']").each((_, a) => {
    const href = ($(a).attr("href") ?? "").trim();
    if (!href) return;
    const e = normalizeEmail(href);
    if (e.includes("@")) mailtoEmails.push(e);
  });
  const textEmails = extractEmailsFromString(visibleText).map((x) => x.value);
  const emailVals = uniqKeepOrder([...mailtoEmails, ...textEmails]).slice(0, 12);
  const emails: ExtractedValue[] = emailVals.map((e) => ({
    value: e,
    snippet: snippetAround(visibleText, e)
  }));

  // ---- PHONES ----
  const phonesRaw = (visibleText.match(PHONE_RE) ?? []).map(normalizePhone).filter(isLikelyPhone);
  const phones = uniqKeepOrder(phonesRaw)
    .slice(0, 10)
    .map((p) => ({ value: p, snippet: snippetAround(visibleText, p) }));

  // ---- CONTACT / BOOKING ----
  const hasContactForm = $("form").length > 0;
  const hasBookingCalendar = BOOKING_PATTERNS.some((re) =>
    re.test(htmlText.toLowerCase())
  );

  // ---- TECH STACK ----
  const techHints: ExtractedValue[] = TECH_PATTERNS.filter((t) =>
    t.re.test(htmlText)
  ).map((t) => ({ value: t.key, snippet: `pattern:${t.key}` }));

  // ---- DECISION MAKERS ----
  const decisionMakers = extractPersons(html, baseUrl);

    return {
    emails,
    phones,
    hasContactForm: hasContactForm
      ? { value: true, snippet: "form detected" }
      : { value: false },
    hasBookingCalendar: hasBookingCalendar
      ? { value: true, snippet: "booking pattern detected" }
      : { value: false },
    techHints,
    decisionMakers
  };
}
