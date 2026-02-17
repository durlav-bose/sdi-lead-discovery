import pLimit from "p-limit";
import { prisma } from "@/lib/prisma";
import { logEvent } from "@/lib/log";
import { env } from "@/lib/env";
import { parseCustomChecks } from "./customChecks";
import { discoverCandidates } from "./connectors/discovery";
import { crawlCompanyWebsite, crawlUrlList } from "./crawl/crawler";
import { expandUrlTemplate, loadCrawlSourcesConfig } from "./crawl/crawlSources";
import { loadCrawlRecipesConfig } from "./crawl/crawlRecipes";
import { browserRunToCrawlResult, runBrowserRecipe } from "./crawl/browserRecipeRunner";
import { verifyLead } from "./verify/verify";

function nowIso() {
  return new Date().toISOString();
}

export async function runLeadDiscovery(runId: string) {
  const run = await prisma.run.findUnique({ where: { id: runId } });
  if (!run) throw new Error(`Run not found: ${runId}`);

  await prisma.run.update({ where: { id: runId }, data: { status: "RUNNING" } });
  await logEvent({
    runId,
    level: "info",
    stage: "system",
    message: "Run started",
    data: { at: nowIso() }
  });

  const parsed = parseCustomChecks(run.customChecksRaw);
  await prisma.run.update({
    where: { id: runId },
    data: { customChecksJson: parsed.checks as any }
  });

  const { source, candidates } = await discoverCandidates({
    industry: run.searchIndustry,
    location: run.searchLocation,
    detailedContext: run.searchDetailedCtx,
    limit: run.targetLeadCount
  });

  await logEvent({
    runId,
    level: "info",
    stage: "discovery",
    message: `Discovery completed (${source})`,
    data: { count: candidates.length }
  });

  const leadIds: string[] = [];
  for (const c of candidates) {
    const lead = await prisma.lead.create({
      data: {
        runId,
        search_industry: run.searchIndustry,
        search_location: run.searchLocation,
        search_detailed_context: run.searchDetailedCtx,
        company_category: null,
        company_name: c.company_name,
        address_street: c.address_street ?? null,
        address_postcode: c.address_postcode ?? null,
        address_locality: c.address_locality ?? null,
        address_city: c.address_city ?? null,
        address_canton: c.address_canton ?? null,
        address_country: c.address_country ?? null,
        company_website: c.company_website ?? null,
        company_email: c.company_email ?? null,
        company_phone: c.company_phone ?? null,
        company_uid_or_registration_id: c.company_uid_or_registration_id ?? null,
        legal_form: c.legal_form ?? null,
        registry_last_update_date: c.registry_last_update_date ?? null,
        industry_code: c.industry_code ?? null
      }
    });
    leadIds.push(lead.id);
  }

  await logEvent({
    runId,
    level: "info",
    stage: "qualification",
    message: "Qualification queued",
    data: { leads: leadIds.length }
  });

  const limit = pLimit(env.ENRICH_CONCURRENCY);
  let processed = 0;
  let failed = 0;
  await Promise.all(
    leadIds.map((leadId) =>
      limit(async () => {
        const r = await prisma.run.findUnique({ where: { id: runId }, select: { stopRequested: true } });
        if (r?.stopRequested) return;

        try {
          await enrichOne(runId, leadId);
        } catch (e: any) {
          failed += 1;
          await logEvent({
            runId,
            level: "error",
            stage: "enrichment",
            message: "Lead enrichment failed",
            data: { leadId, error: String(e?.message ?? e) }
          }).catch(() => {});

          const lead = await prisma.lead.findUnique({ where: { id: leadId } }).catch(() => null);
          if (lead) {
            const vr = verifyLead(lead);
            await prisma.lead
              .update({
                where: { id: leadId },
                data: {
                  quality_status: vr.status,
                  quality_reasons: [...(vr.reasons as any[]), "enrichment_error"] as any
                }
              })
              .catch(() => {});
          }
        }
        processed += 1;
        await logEvent({
          runId,
          level: "info",
          stage: "enrichment",
          message: `Processed ${processed}/${leadIds.length}`,
          data: { leadId, failed }
        });
      })
    )
  );

  const r2 = await prisma.run.findUnique({ where: { id: runId }, select: { stopRequested: true } });
  if (r2?.stopRequested) {
    await prisma.run.update({ where: { id: runId }, data: { status: "COMPLETED" } });
    await logEvent({
      runId,
      level: "warn",
      stage: "system",
      message: "Run stopped by user",
      data: { at: nowIso() }
    });
    return;
  }

  await prisma.run.update({ where: { id: runId }, data: { status: "COMPLETED" } });
  await logEvent({
    runId,
    level: "info",
    stage: "system",
    message: "Run completed",
    data: { at: nowIso() }
  });
}

async function enrichOne(runId: string, leadId: string) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return;

  const website = lead.company_website;
  if (!website) {
    const vr = verifyLead(lead);
    await prisma.lead.update({
      where: { id: leadId },
      data: { quality_status: vr.status, quality_reasons: vr.reasons as any }
    });
    return;
  }

  await logEvent({
    runId,
    level: "info",
    stage: "enrichment",
    message: "Enrichment started",
    data: { leadId, website }
  });

  const crawlPromise = crawlCompanyWebsite({
    website,
    runId,
    maxPages: env.CRAWL_MAX_PAGES,
    fetchTimeoutMs: env.CRAWL_FETCH_TIMEOUT_MS
  });

  const crawl = await promiseWithTimeout(crawlPromise, env.ENRICH_LEAD_TIMEOUT_MS, "enrich_timeout");
  if (!crawl) {
    await logEvent({
      runId,
      level: "warn",
      stage: "enrichment",
      message: "Enrichment timed out",
      data: { leadId, website, timeoutMs: env.ENRICH_LEAD_TIMEOUT_MS }
    });

    const vr = verifyLead(lead);
    await prisma.lead.update({
      where: { id: leadId },
      data: { quality_status: vr.status, quality_reasons: [...(vr.reasons as any[]), "enrichment_timeout"] as any }
    });
    return;
  }

  // ---- Extra sources from crawl-sources.json (expanded per lead) ----
  try {
    const cfg = loadCrawlSourcesConfig();
    const origin = new URL(website).origin;
    const vars: Record<string, string> = {
      website,
      websiteOrigin: origin,
      companyName: String(lead.company_name ?? "").trim(),
      location: String(lead.search_location ?? "").trim(),
      industry: String(lead.search_industry ?? "").trim()
    };

    const extraUrls = (cfg.sources ?? [])
      .filter((s) => s && s.enabled !== false)
      .map((s) => expandUrlTemplate(s.urlTemplate, vars))
      .map((u) => u.trim())
      .filter(Boolean);

    if (extraUrls.length > 0) {
      await logEvent({
        runId,
        level: "info",
        stage: "enrichment",
        message: "Crawling extra sources",
        data: { leadId, count: extraUrls.length }
      }).catch(() => {});

      const extra = await promiseWithTimeout(
        crawlUrlList({ urls: extraUrls, runId, fetchTimeoutMs: env.CRAWL_FETCH_TIMEOUT_MS, maxUrls: 8 }),
        Math.min(env.ENRICH_LEAD_TIMEOUT_MS, 15_000),
        "extra_sources_timeout"
      );

      if (extra) {
        crawl.pages.push(...extra.pages);
        crawl.evidence.push(...extra.evidence);
        crawl.signals.emails = Array.from(new Set([...(crawl.signals.emails ?? []), ...(extra.signals.emails ?? [])])).slice(0, 12);
        crawl.signals.phones = Array.from(new Set([...(crawl.signals.phones ?? []), ...(extra.signals.phones ?? [])])).slice(0, 10);
        crawl.signals.techHints = Array.from(new Set([...(crawl.signals.techHints ?? []), ...(extra.signals.techHints ?? [])])).slice(0, 12);
        crawl.signals.hasContactForm = Boolean(crawl.signals.hasContactForm || extra.signals.hasContactForm);
        crawl.signals.hasBookingCalendar = Boolean(crawl.signals.hasBookingCalendar || extra.signals.hasBookingCalendar);
        crawl.signals.decisionMakers = ([
          ...(crawl.signals.decisionMakers as any[]),
          ...(extra.signals.decisionMakers as any[])
        ] as any[])
          .sort((a, b) => (b?.confidence ?? 0) - (a?.confidence ?? 0))
          .slice(0, 10) as any;
      }
    }
  } catch (e: any) {
    await logEvent({
      runId,
      level: "warn",
      stage: "enrichment",
      message: "Extra sources crawl skipped/failed",
      data: { leadId, error: String(e?.message ?? e) }
    }).catch(() => {});
  }

  // ---- Browser automation recipes (crawl-recipes.json) ----
  try {
    const cfg = loadCrawlRecipesConfig();
    const allowBrowser = env.ENABLE_BROWSER_CRAWL === "1" || cfg.enabled;
    if (allowBrowser && cfg.enabled && Array.isArray(cfg.recipes) && cfg.recipes.length > 0) {
        const origin = new URL(website).origin;
        const vars: Record<string, string> = {
          website,
          websiteOrigin: origin,
          companyName: String(lead.company_name ?? "").trim(),
          location: String(lead.search_location ?? "").trim(),
          industry: String(lead.search_industry ?? "").trim()
        };

        const enabledRecipes = cfg.recipes.filter((r) => r && r.enabled !== false);
        for (const r of enabledRecipes.slice(0, 3)) {
          await logEvent({
            runId,
            level: "info",
            stage: "enrichment",
            message: "Running browser recipe",
            data: { leadId, recipe: r.name }
          }).catch(() => {});

          const run = await promiseWithTimeout(
            runBrowserRecipe({
              startUrlTemplate: r.startUrlTemplate,
              steps: r.steps,
              vars,
              fetchTimeoutMs: Math.min(env.CRAWL_FETCH_TIMEOUT_MS, 15000)
            }),
            Math.min(env.ENRICH_LEAD_TIMEOUT_MS, 20000),
            "browser_recipe_timeout"
          );
          if (!run) continue;
          await logEvent({
            runId,
            level: "info",
            stage: "enrichment",
            message: "Browser recipe completed",
            data: { leadId, recipe: r.name, url: run.url }
          }).catch(() => {});
          const extra = browserRunToCrawlResult(run);
          crawl.pages.push(...extra.pages);
          crawl.evidence.push(...extra.evidence);
          crawl.signals.emails = Array.from(new Set([...(crawl.signals.emails ?? []), ...(extra.signals.emails ?? [])])).slice(0, 12);
          crawl.signals.phones = Array.from(new Set([...(crawl.signals.phones ?? []), ...(extra.signals.phones ?? [])])).slice(0, 10);
          crawl.signals.techHints = Array.from(new Set([...(crawl.signals.techHints ?? []), ...(extra.signals.techHints ?? [])])).slice(0, 12);
          crawl.signals.hasContactForm = Boolean(crawl.signals.hasContactForm || extra.signals.hasContactForm);
          crawl.signals.hasBookingCalendar = Boolean(crawl.signals.hasBookingCalendar || extra.signals.hasBookingCalendar);
          crawl.signals.decisionMakers = ([
            ...(crawl.signals.decisionMakers as any[]),
            ...(extra.signals.decisionMakers as any[])
          ] as any[])
            .sort((a, b) => (b?.confidence ?? 0) - (a?.confidence ?? 0))
            .slice(0, 10) as any;
        }
    }
  } catch (e: any) {
    await logEvent({
      runId,
      level: "warn",
      stage: "enrichment",
      message: "Browser recipes skipped/failed",
      data: { leadId, error: String(e?.message ?? e) }
    }).catch(() => {});
  }

  const websiteHost = safeHostname(website);
  const company_email = pickBestCompanyEmail(crawl.signals.emails ?? [], websiteHost) ?? lead.company_email ?? null;
  const company_phone = pickBestCompanyPhone(crawl.evidence ?? [], website) ?? lead.company_phone ?? null;
  const has_contact_form = crawl.signals.hasContactForm ?? null;
  const has_booking_calendar = crawl.signals.hasBookingCalendar ?? null;
  const tech_stack_hints = crawl.signals.techHints?.length
    ? crawl.signals.techHints.join(", ")
    : null;

  const evidence_json = Array.isArray(crawl.evidence) ? [...crawl.evidence] : [];

  if (!crawl.signals.phones?.length && lead.company_phone) {
    evidence_json.push({
      field: "company_phone",
      source_url: "discovery",
      snippet: "Provided by discovery connector",
      retrieved_at: nowIso()
    });
  }
  if (!crawl.signals.emails?.length && lead.company_email) {
    evidence_json.push({
      field: "company_email",
      source_url: "discovery",
      snippet: "Provided by discovery connector",
      retrieved_at: nowIso()
    });
  }

  // ----- Decision Makers -----
  if (Array.isArray(crawl.signals.decisionMakers) && crawl.signals.decisionMakers.length > 0) {
    const persons = crawl.signals.decisionMakers as any[];
    const dmDelegate = (prisma as any).decisionMaker;
    if (dmDelegate?.create) {
      try {
        for (const dm of persons) {
          await dmDelegate.create({
            data: {
              leadId,
              name: dm.name,
              role: dm.role,
              email: dm.email,
              emailStatus: "published_only",
              emailEvidence: dm.emailEvidence,
              phone: dm.phone,
              phoneStatus: "published_only",
              phoneEvidence: dm.phoneEvidence,
              confidence: dm.confidence,
              evidenceJson: dm.evidenceJson
            }
          });
        }
      } catch (e: any) {
        await logEvent({
          runId,
          level: "warn",
          stage: "enrichment",
          message: "DecisionMaker persistence failed; skipping persistence",
          data: { leadId, error: String(e?.message ?? e) }
        }).catch(() => {});
      }
    } else {
      await logEvent({
        runId,
        level: "warn",
        stage: "enrichment",
        message: "DecisionMaker model not available in Prisma client; skipping persistence",
        data: { leadId }
      }).catch(() => {});
    }

    const top = persons.sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
    const topConf = Number(top?.confidence ?? 0);
    const hasMeaningful = Boolean(String(top?.role ?? "").trim()) || Boolean(String(top?.email ?? "").trim()) || Boolean(String(top?.phone ?? "").trim());
    if (top && topConf >= 55 && hasMeaningful) {
      const dmName = String(top.name ?? "").trim();
      const dmEmailRaw = String(top.email ?? "").trim().toLowerCase();
      const dmEmail = dmEmailRaw && emailLooksPersonalForName(dmEmailRaw, dmName) ? dmEmailRaw : null;
      await prisma.lead.update({
        where: { id: leadId },
        data: {
          decision_maker_name: top.name,
          decision_maker_role: top.role,
          decision_maker_email: dmEmail,
          decision_maker_email_status: "published_only",
          decision_maker_email_evidence: dmEmail ? top.emailEvidence : null,
          decision_maker_phone: top.phone,
          decision_maker_phone_status: "published_only",
          decision_maker_phone_evidence: top.phoneEvidence
        }
      });
    }
  }

  // ----- Update Lead data -----
  const updated = await prisma.lead.update({
    where: { id: leadId },
    data: {
      company_email,
      company_phone,
      has_contact_form,
      has_contact_form_evidence: has_contact_form
        ? findFirstEvidence(evidence_json, "has_contact_form")
        : null,
      has_booking_calendar,
      has_booking_calendar_evidence: has_booking_calendar
        ? findFirstEvidence(evidence_json, "has_booking_calendar")
        : null,
      tech_stack_hints,
      tech_stack_hints_evidence: tech_stack_hints
        ? findFirstEvidence(evidence_json, "tech_stack_hints")
        : null,
      evidence_json
    }
  });

  const vr = verifyLead(updated);
  await prisma.lead.update({
    where: { id: leadId },
    data: { quality_status: vr.status, quality_reasons: vr.reasons as any }
  });
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function isGenericMailboxEmail(email: string) {
  const e = String(email ?? "").trim().toLowerCase();
  const at = e.indexOf("@");
  if (at < 1) return true;
  const local = e.slice(0, at);
  return /^(info|kontakt|contact|office|admin|mail|hello|team|service|support|marketing|sales|booking|termin|appointment|praxis|empfang)$/.test(local);
}

function emailLooksPersonalForName(email: string, name: string) {
  const e = String(email ?? "").trim().toLowerCase();
  if (!e.includes("@")) return false;
  if (isGenericMailboxEmail(e)) return false;
  const local = e.split("@")[0] ?? "";
  const toks = String(name ?? "")
    .toLowerCase()
    .replace(/[^a-zà-öø-ÿ\s-]/gi, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  if (toks.length < 2) return false;
  const first = toks[0];
  const last = toks[toks.length - 1];
  if (last && local.includes(last)) return true;
  if (first && last && local.includes(first[0]) && local.includes(last)) return true;
  return false;
}

function pickBestCompanyEmail(emails: string[], websiteHost: string): string | null {
  const cleaned = (emails ?? []).map((e) => String(e ?? "").trim().toLowerCase()).filter(Boolean);
  if (!cleaned.length) return null;
  if (!websiteHost) return cleaned[0] ?? null;

  const match = cleaned.find((e) => {
    const at = e.lastIndexOf("@");
    if (at < 0) return false;
    const domain = e.slice(at + 1).replace(/^www\./i, "");
    return domain === websiteHost || domain.endsWith(`.${websiteHost}`);
  });
  return match ?? null;
}

function pickBestCompanyPhone(evidence: any[], website: string): string | null {
  const origin = (() => {
    try {
      return new URL(website).origin;
    } catch {
      return "";
    }
  })();
  const items = Array.isArray(evidence) ? evidence : [];
  const sameOriginPhone = items.find((e) => e?.field === "company_phone" && typeof e?.source_url === "string" && origin && String(e.source_url).startsWith(origin));
  if (sameOriginPhone?.snippet && typeof sameOriginPhone.snippet === "string") {
    const m = sameOriginPhone.snippet.match(/(\+?\d[\d\s().-]{7,}\d)/);
    if (m?.[1]) return m[1].replace(/\s+/g, " ").trim();
  }
  return null;
}

async function promiseWithTimeout<T>(p: Promise<T>, timeoutMs: number, _tag: string): Promise<T | null> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      })
    ]);
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function findFirstEvidence(evidence: any[], field: string): string | null {
  const item = evidence.find((e) => e.field === field);
  if (!item) return null;
  return `${item.source_url} | ${item.snippet}`.slice(0, 500);
}
