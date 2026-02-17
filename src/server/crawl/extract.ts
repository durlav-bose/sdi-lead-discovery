import * as cheerio from "cheerio";
import { extractPersons } from "./personExtract";

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

const TECH_PATTERNS: Array<{ key: string; re: RegExp }> = [
  { key: "shopify", re: /cdn\.shopify\.com|myshopify\.com|\bshopify\b/i },
  { key: "wordpress", re: /wp-content|wp-includes|\bwordpress\b/i },
  { key: "wix", re: /wixstatic\.com|\bwix\.com\b/i },
  { key: "squarespace", re: /static1\.squarespace\.com|\bsquarespace\b/i },
  { key: "webflow", re: /\bwebflow\b|data-wf-page/i },
  { key: "jimdo", re: /\bjimdo\b/i }
];

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

  // Common false positives: year ranges like 2010-2012
  if (/\b(19\d{2}|20\d{2})\s*[-–]\s*(19\d{2}|20\d{2})\b/.test(s)) return false;

  const digits = s.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return false;

  // Reject long sequences that look like IDs rather than phone numbers
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

export function extractSignals(html: string, baseUrl: string): ExtractedContact {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe").remove();
  $("br").replaceWith("\n");
  $("p,div,li,section,article,header,footer,table,tr").each((_, el) => {
    $(el).prepend("\n").append("\n");
  });
  const visibleText = $("body").text().replace(/\u00a0/g, " ");
  const htmlText = $.root().html() ?? "";

  const mailtoEmails: string[] = [];
  $("a[href^='mailto:']").each((_, a) => {
    const href = ($(a).attr("href") ?? "").trim();
    if (!href) return;
    const e = normalizeEmail(href);
    if (e.includes("@")) mailtoEmails.push(e);
  });
  const textEmails = extractEmailsFromString(visibleText).map((x) => x.value);
  const emailVals = uniqKeepOrder([...mailtoEmails, ...textEmails]).slice(0, 12);
  const emails: ExtractedValue[] = emailVals.map((e) => ({ value: e, snippet: snippetAround(visibleText, e) }));

  const phonesRaw = (visibleText.match(PHONE_RE) ?? []).map(normalizePhone).filter(isLikelyPhone);
  const phones = uniqKeepOrder(phonesRaw)
    .slice(0, 10)
    .map((p) => ({ value: p, snippet: snippetAround(visibleText, p) }));

  const hasContactForm = $("form").length > 0;
  const lowerHtml = htmlText.toLowerCase();
  const hasBookingCalendar = BOOKING_PATTERNS.some((re) => re.test(lowerHtml));

  const techHints: ExtractedValue[] = TECH_PATTERNS.filter((t) => t.re.test(htmlText)).map((t) => ({
    value: t.key,
    snippet: `pattern:${t.key}`
  }));

  const decisionMakers = extractPersons(html, baseUrl);
  return {
    emails,
    phones,
    hasContactForm: hasContactForm ? { value: true, snippet: "form detected" } : { value: false },
    hasBookingCalendar: hasBookingCalendar ? { value: true, snippet: "booking pattern detected" } : { value: false },
    techHints,
    decisionMakers
  };
}
