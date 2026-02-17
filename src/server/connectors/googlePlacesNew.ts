import { CandidateCompany } from "../types";

type AddressComponent = {
  longText?: string;
  shortText?: string;
  types?: string[];
};

type TextSearchResponse = {
  places?: Array<{ id?: string }>;
  nextPageToken?: string;
};

type PlaceDetailsResponse = {
  id?: string;
  displayName?: { text?: string };
  websiteUri?: string;
  internationalPhoneNumber?: string;
  nationalPhoneNumber?: string;
  formattedAddress?: string;
  addressComponents?: AddressComponent[];
};

function pick(components: AddressComponent[] | undefined, type: string): string {
  const c = components?.find(x => (x.types ?? []).includes(type));
  return (c?.longText ?? c?.shortText ?? "").trim();
}

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms));
}

async function searchTextIds(params: {
  apiKey: string;
  industry: string;
  location: string;
  regionCode: string;
  languageCode: string;
  limit: number;
}) {
  const ids: string[] = [];
  let pageToken: string | undefined;

  const regionCode = (params.regionCode || "CH").toUpperCase();
  const languageCode = (params.languageCode || "de").toLowerCase();
  const locationClean = (params.location || "").replace(/\s*\/\s*/g, ", ").trim();
  const query = `${params.industry} in ${locationClean}`;

  while (ids.length < params.limit) {
    if (pageToken) {
      // defensiv – manche Tokens sind nicht sofort nutzbar
      await sleep(2000);
    }

    const remaining = params.limit - ids.length;
    const pageSize = Math.min(20, remaining);

    const body: any = {
      textQuery: query,
      regionCode,
      languageCode,
      pageSize,
    };
    if (pageToken) body.pageToken = pageToken;

    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": params.apiKey,
        // WICHTIG: IDs-only, damit die Search möglichst günstig bleibt
        "X-Goog-FieldMask": "places.id,nextPageToken",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      throw new Error(`searchText failed (${res.status}): ${await res.text()}`);
    }

    const data = (await res.json()) as TextSearchResponse;
    const batch = (data.places ?? []).map(p => p.id).filter(Boolean) as string[];

    for (const id of batch) {
      if (!ids.includes(id)) ids.push(id);
      if (ids.length >= params.limit) break;
    }

    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }

  return ids;
}

async function getPlaceDetails(apiKey: string, placeId: string) {
  // Das sind genau die Felder, die wir brauchen (weniger = billiger/schneller)
  const fieldMask =
    "id,displayName,websiteUri,internationalPhoneNumber,nationalPhoneNumber,formattedAddress,addressComponents";

  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": fieldMask,
    },
  });

  if (!res.ok) {
    throw new Error(`placeDetails failed (${res.status}): ${await res.text()}`);
  }

  return (await res.json()) as PlaceDetailsResponse;
}

export async function googlePlacesNewDiscover(params: {
  industry: string;
  location: string;
  limit: number;
  apiKey: string;
  regionCode: string;
  languageCode: string;
}): Promise<CandidateCompany[]> {
  const regionCode = (params.regionCode || "CH").toUpperCase();
  const languageCode = (params.languageCode || "de").toLowerCase();

  const ids = await searchTextIds({
    apiKey: params.apiKey,
    industry: params.industry,
    location: params.location,
    regionCode,
    languageCode,
    limit: params.limit,
  });

  const results: CandidateCompany[] = [];

  for (const id of ids) {
    const d = await getPlaceDetails(params.apiKey, id);
    const comps = d.addressComponents ?? [];

    const postcode = pick(comps, "postal_code");
    const city =
      pick(comps, "locality") ||
      pick(comps, "postal_town") ||
      pick(comps, "administrative_area_level_3");

    const locality =
      pick(comps, "sublocality") ||
      pick(comps, "sublocality_level_1") ||
      pick(comps, "neighborhood");

    const canton = pick(comps, "administrative_area_level_1");

    results.push({
      company_name: d.displayName?.text || "(unknown)",
      company_website: (d.websiteUri || "").trim(),
      company_phone: (d.internationalPhoneNumber || d.nationalPhoneNumber || "").trim() || undefined,
      address_postcode: postcode || undefined,
      address_city: city || undefined,
      address_locality: locality || undefined,
      address_canton: canton || undefined,
      address_country: regionCode,
    });
  }

  return results;
}