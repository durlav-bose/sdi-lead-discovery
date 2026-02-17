import { CandidateCompany } from "../types";

/**
 * Dev-only mock connector.
 * IMPORTANT: This is NOT claiming these entries come from the Swiss registry.
 * It exists so the pipeline + UI can be tested without paid APIs.
 */
export function mockRegistryDiscover(params: {
  industry: string;
  location: string;
  limit: number;
}): CandidateCompany[] {
  const { industry, location, limit } = params;

  const base: CandidateCompany[] = [
    {
      company_name: "Example Consulting AG",
      company_website: "https://example.com",
      address_city: "Zug",
      address_canton: "ZG",
      address_country: "CH",
      company_uid_or_registration_id: "MOCK-UID-0001",
      legal_form: "AG"
    },
    {
      company_name: "Sample Logistics GmbH",
      company_website: "https://www.iana.org",
      address_city: "Zürich",
      address_canton: "ZH",
      address_country: "CH",
      company_uid_or_registration_id: "MOCK-UID-0002",
      legal_form: "GmbH"
    }
  ];

  // Simple expansion based on limit (still mock)
  const out: CandidateCompany[] = [];
  let i = 0;
  while (out.length < limit) {
    const t = base[i % base.length];
    const n = Math.floor(i / base.length) + 1;
    out.push({
      ...t,
      company_name: `${t.company_name} ${n}`,
      industry_code: industry ? `MOCK-${industry.slice(0, 8)}` : "MOCK",
      registry_last_update_date: new Date().toISOString().slice(0, 10),
      address_city: location ? location : t.address_city
    });
    i += 1;
  }
  return out;
}
