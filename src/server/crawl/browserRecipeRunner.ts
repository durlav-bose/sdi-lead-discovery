import { extractSignals } from "./crawler";
import { expandUrlTemplate } from "./crawlSources";
import { CrawlEvidenceItem, CrawlResult } from "./crawler";

type BrowserRunResult = {
  url: string;
  extracted: Record<string, string>;
  html?: string;
  text?: string;
};

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

async function loadPlaywright(): Promise<any> {
  const req = (0, eval)("require") as any;
  return req("playwright");
}

export async function runBrowserRecipe(params: {
  startUrlTemplate: string;
  steps: any[];
  vars: Record<string, string>;
  fetchTimeoutMs: number;
}): Promise<BrowserRunResult | null> {
  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch({ headless: true });
  const page = await browser.newPage();

  const url = expandUrlTemplate(params.startUrlTemplate, params.vars);
  const extracted: Record<string, string> = {};

  try {
    const steps = Array.isArray(params.steps) ? params.steps : [];
    for (const step of steps) {
      const t = String(step?.type ?? "");
      if (t === "goto") {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: params.fetchTimeoutMs });
      } else if (t === "waitForSelector") {
        await page.waitForSelector(String(step.selector), { timeout: step.timeoutMs ?? params.fetchTimeoutMs });
      } else if (t === "waitForTimeout") {
        await page.waitForTimeout(Number(step.ms ?? 0));
      } else if (t === "fill") {
        const v = expandUrlTemplate(String(step.valueTemplate ?? ""), params.vars);
        await page.fill(String(step.selector), v, { timeout: params.fetchTimeoutMs });
      } else if (t === "click") {
        const sel = String(step.selector);
        await page.waitForSelector(sel, { timeout: params.fetchTimeoutMs }).catch(() => {});
        await page.click(sel, { timeout: params.fetchTimeoutMs });
        await page.waitForLoadState("domcontentloaded", { timeout: params.fetchTimeoutMs }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: params.fetchTimeoutMs }).catch(() => {});
      } else if (t === "extractText") {
        const txt = await page.textContent(String(step.selector));
        extracted[String(step.field ?? "field")] = (txt ?? "").trim();
      }
    }

    const html = await page.content();
    const text = await page.textContent("body");
    return { url, extracted, html, text: (text ?? "").trim() };
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

export function browserRunToCrawlResult(run: BrowserRunResult): CrawlResult {
  const pages = [{ url: run.url, status: 200, contentType: "text/html" }];
  const evidence: CrawlEvidenceItem[] = [];

  const html = run.html ?? "";
  const signals = extractSignals(html, run.url);

  for (const e of signals.emails ?? []) {
    evidence.push({ field: "company_email", source_url: run.url, snippet: e.snippet, retrieved_at: nowIso() });
  }
  for (const p of signals.phones ?? []) {
    evidence.push({ field: "company_phone", source_url: run.url, snippet: p.snippet, retrieved_at: nowIso() });
  }

  if (signals.hasContactForm?.value) {
    evidence.push({ field: "has_contact_form", source_url: run.url, snippet: signals.hasContactForm.snippet ?? "form detected", retrieved_at: nowIso() });
  }
  if (signals.hasBookingCalendar?.value) {
    evidence.push({ field: "has_booking_calendar", source_url: run.url, snippet: signals.hasBookingCalendar.snippet ?? "booking detected", retrieved_at: nowIso() });
  }

  for (const t of signals.techHints ?? []) {
    evidence.push({ field: "tech_stack_hints", source_url: run.url, snippet: t.snippet, retrieved_at: nowIso() });
  }

  if (Array.isArray(signals.decisionMakers)) {
    for (const dm of signals.decisionMakers as any[]) {
      if (dm?.emailEvidence) evidence.push({ field: "decision_maker_email", source_url: String(dm.emailEvidence), snippet: dm.email ?? "", retrieved_at: nowIso() });
      if (dm?.phoneEvidence) evidence.push({ field: "decision_maker_phone", source_url: String(dm.phoneEvidence), snippet: dm.phone ?? "", retrieved_at: nowIso() });
    }
  }

  return {
    pages,
    signals: {
      emails: uniqKeepOrderStr((signals.emails ?? []).map((x) => x.value)).slice(0, 12),
      phones: uniqKeepOrderStr((signals.phones ?? []).map((x) => x.value)).slice(0, 10),
      hasContactForm: Boolean(signals.hasContactForm?.value),
      hasBookingCalendar: Boolean(signals.hasBookingCalendar?.value),
      techHints: uniqKeepOrderStr((signals.techHints ?? []).map((x) => x.value)).slice(0, 12),
      decisionMakers: (signals.decisionMakers as any[]) ?? []
    },
    evidence
  };
}
