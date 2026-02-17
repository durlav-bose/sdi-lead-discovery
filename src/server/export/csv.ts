import { Lead } from "@prisma/client";

export const CSV_HEADERS = [
  "search_industry",
  "search_location",
  "search_detailed_context",
  "company_category",
  "company_name",
  "address_street",
  "address_postcode",
  "address_locality",
  "address_city",
  "address_canton",
  "address_country",
  "decision_maker_name",
  "decision_maker_role",
  "decision_maker_email",
  "decision_maker_email_status",
  "decision_maker_email_evidence",
  "decision_maker_phone",
  "decision_maker_phone_status",
  "decision_maker_phone_evidence",
  "notes",
  "company_website",
  "company_email",
  "company_phone",
  "company_size_employee_count",
  "company_size_site_count",
  "company_size_site_locations",
  "ai_custom_checks_json",
  "evidence_json",
  "quality_status",
  "quality_reasons"
] as const;

export function toCsvRow(lead: Lead): string[] {
  const obj: Record<string, any> = lead as any;
  return CSV_HEADERS.map((h) => {
    const v = obj[h];
    if (v === null || v === undefined) return "";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  });
}

export function csvEscape(value: string): string {
  if (value.includes('"') || value.includes(',') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function rowsToCsv(rows: string[][]): string {
  const lines = [CSV_HEADERS.join(","), ...rows.map((r) => r.map(csvEscape).join(","))];
  return lines.join("\n") + "\n";
}
