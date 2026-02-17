function hostnameOf(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function emailDomain(email: string) {
  const m = email.toLowerCase().match(/@([^>\s]+)/);
  return m ? m[1].replace(/^www\./, "") : "";
}

function isGenericMailboxEmail(email: string) {
  const e = String(email ?? "").trim().toLowerCase();
  const at = e.indexOf("@");
  if (at < 1) return true;
  const local = e.slice(0, at);
  return /^(info|kontakt|contact|office|admin|mail|hello|team|service|support|marketing|sales|booking|termin|appointment|praxis|empfang)$/.test(local);
}

function nameTokens(name: string) {
  return String(name ?? "")
    .toLowerCase()
    .replace(/[^a-zà-öø-ÿ\s-]/gi, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
}

function emailLooksPersonalForName(email: string, name: string) {
  const e = String(email ?? "").trim().toLowerCase();
  if (!e.includes("@")) return false;
  if (isGenericMailboxEmail(e)) return false;
  const local = e.split("@")[0] ?? "";
  const toks = nameTokens(name);
  if (toks.length < 2) return false;
  const last = toks[toks.length - 1];
  const first = toks[0];
  // Require last name or a recognizable abbreviation pattern
  if (last && local.includes(last)) return true;
  if (first && last && local.includes(first[0]) && local.includes(last)) return true;
  return false;
}

// Conservative: only treat phones as "verified" if they look like real phone numbers (avoid dates/IDs)
function stripNonDigits(s: string) { return s.replace(/[^0-9]/g, ""); }
function looksLikeDate(s: string) { return /^\d{4}[-\/.]\d{2}[-\/.]\d{2}$/.test(s.trim()); }
function isPlausiblePhone(raw: string) {
  const t = raw.trim();
  if (!t) return false;
  if (looksLikeDate(t)) return false;
  const digits = stripNonDigits(t);
  if (digits.length < 9 || digits.length > 15) return false;
  if (/^(\d)\1+$/.test(digits)) return false;
  if (/^20\d{6}$/.test(digits)) return false;
  return true;
}

function hasEvidence(evidence: any[] | null | undefined, field: string) {
    return (evidence ?? []).some((e) => e.field === field && e.source_url);
}

export function verifyLead(lead: any) {
  const reasons: string[] = [];

  const website = (lead.company_website ?? lead.website ?? "") as string;
  const host = hostnameOf(website);

  const companyName = ((lead.company_name ?? lead.companyName ?? "") as string).trim();
  const hasCompanyName = companyName.length > 2 && !/^seed company/i.test(companyName);

  const emails = (lead.company_email ? [lead.company_email] : (lead.emails ?? [])) as string[];
  const phones = ((lead.company_phone ? [lead.company_phone] : (lead.phones ?? [])) as string[]).filter(isPlausiblePhone);

  const dmEmail = String(lead.decision_maker_email ?? "").trim();
  const dmName = String(lead.decision_maker_name ?? "").trim();
  const dmEmailEvidence = hasEvidence((lead.evidence_json ?? lead.evidence) as any, "decision_maker_email");
  const hasPersonalDecisionMakerEmail = !!dmEmail && !!dmName && emailLooksPersonalForName(dmEmail, dmName) && dmEmailEvidence;

  const hasEmail = emails.length > 0;
  const hasPhone = phones.length > 0;

  const emailMatchesDomain =
    host &&
    emails.some((e) => {
      const d = emailDomain(e);
      return d === host || d.endsWith("." + host);
    });

  // Evidence gates: we only consider a field "solid" if we have evidence snippets
  const emailEvidence = hasEvidence((lead.evidence_json ?? lead.evidence) as any, "company_email");
  const phoneEvidence = hasEvidence((lead.evidence_json ?? lead.evidence) as any, "company_phone");

  if (!website) reasons.push("missing website");
  if (!hasCompanyName) reasons.push("missing/weak company name");
  if (!hasEmail) reasons.push("missing email");
  if (!hasPhone) reasons.push("missing phone");
  if (!hasPersonalDecisionMakerEmail) reasons.push("missing personal decision maker email");
  if (hasEmail && !emailEvidence) reasons.push("no email evidence");
  if (hasPhone && !phoneEvidence) reasons.push("no phone evidence");
  if (hasEmail && host && !emailMatchesDomain) reasons.push("email domain does not match website domain");

  // VERIFIED: strict (aim for '100%') – must have website + name + domain-matching email + plausible phone + evidence
  const isVerified =
    !!website &&
    hasCompanyName &&
    hasEmail &&
    hasPhone &&
    hasPersonalDecisionMakerEmail &&
    emailMatchesDomain &&
    emailEvidence &&
    phoneEvidence;

  if (isVerified) return { status: "VERIFIED" as const, reasons: [] };

  // NEEDS_REVIEW: has enough basics to be usable, but fails strict verification
  const hasBasics = !!website && (hasEmail || hasPhone);
  if (hasBasics) return { status: "NEEDS_REVIEW" as const, reasons };

  return { status: "INCOMPLETE" as const, reasons };
}
