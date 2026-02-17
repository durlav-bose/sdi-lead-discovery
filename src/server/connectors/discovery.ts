import { CandidateCompany } from "../types";
import { extractUrlSeeds } from "../urlSeeds";
import { mockRegistryDiscover } from "./mockRegistry";
import { googlePlacesNewDiscover } from "./googlePlacesNew";
import { env } from "@/lib/env";

function titleCaseWords(s: string) {
  return s
    .split(/\s+/g)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function companyNameFromSeedUrl(u: string, fallback: string) {
  try {
    const host = new URL(u).hostname.replace(/^www\./i, "");
    const base = host.split(".")[0] || host;
    const cleaned = base.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    if (!cleaned) return fallback;
    return titleCaseWords(cleaned);
  } catch {
    return fallback;
  }
}

/**
 * Discovery strategy:
 * 1) If the user pasted URLs into the detailed context, use those as seeds.
 * 2) Otherwise use Google Places (New) if a key is configured.
 * 3) Otherwise fallback to a dev-only mock connector.
 */
export async function discoverCandidates(params: {
  industry: string;
  location: string;
  detailedContext: string;
  limit: number;
}): Promise<{ source: "seeds" | "google_places" | "mock_registry"; candidates: CandidateCompany[] }> {
  const seeds = extractUrlSeeds(params.detailedContext);

  if (seeds.length > 0) {
    const candidates: CandidateCompany[] = seeds.slice(0, params.limit).map((u, idx) => ({
      company_name: companyNameFromSeedUrl(u, `Seed Company ${idx + 1}`),
      company_website: u,
      address_country: "CH",
    }));

    return { source: "seeds", candidates };
  }

  // If a Google Maps API key is provided, use Google Places (New) for real discovery.
  console.log(`googleMapsKey=${env.GOOGLE_MAPS_API_KEY ? "YES" : "NO"}`);
  if (env.GOOGLE_MAPS_API_KEY) {
    const candidates = await googlePlacesNewDiscover({
      industry: params.industry,
      location: params.location,
      limit: params.limit,
      apiKey: env.GOOGLE_MAPS_API_KEY,
      regionCode: env.GOOGLE_PLACES_REGION,
      languageCode: env.GOOGLE_PLACES_LANGUAGE,
    });

    console.log(`Discovered ${candidates.length} candidates from Google Places for industry="${params.industry}" location="${params.location}"`);

    return { source: "google_places", candidates };
  }

  return {
    source: "mock_registry",
    candidates: mockRegistryDiscover({ industry: params.industry, location: params.location, limit: params.limit }),
  };
}