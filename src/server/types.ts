export type CustomCheck = {
  id: string;
  name: string;
  type: "boolean" | "text" | "number" | "enum";
  description?: string;
};

export type CandidateCompany = {
  company_name: string;
  company_website?: string | null;
  company_phone?: string | null;
  company_email?: string | null;

  address_street?: string | null;
  address_postcode?: string | null;
  address_locality?: string | null;
  address_city?: string | null;
  address_canton?: string | null;
  address_country?: string | null;
  company_uid_or_registration_id?: string | null;
  legal_form?: string | null;
  registry_last_update_date?: string | null;
  industry_code?: string | null;
};

export type EvidenceItem = {
  field: string;
  source_url: string;
  snippet: string;
  retrieved_at: string; // ISO
};

export type VerificationResult = {
  quality_status: "VERIFIED" | "NEEDS_REVIEW" | "INCOMPLETE";
  reasons: string[];
};

export type DecisionMaker = {
  id: string;
  leadId: string;
  name: string;
  role?: string | null;
  email?: string | null;
  emailStatus?: string | null;
  emailEvidence?: string | null;
  phone?: string | null;
  phoneStatus?: string | null;
  phoneEvidence?: string | null;
  confidence?: number | null;
  evidenceJson?: any;
};
