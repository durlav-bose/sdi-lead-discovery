import { CandidateCompany } from "../types";

type LatLng = { lat: number; lng: number };

type GeocodeResponse = {
  status: string;
  error_message?: string;
  results: Array<{
    geometry: {
      viewport: { northeast: LatLng; southwest: LatLng };
    };
  }>;
};

type NearbySearchResponse = {
  status: string;
  error_message?: string;
  next_page_token?: string;
  results: Array<{
    place_id: string;
  }>;
};

type PlaceDetailsResponse = {
  status: string;
  error_message?: string;
  result: {
    name?: string;
    website?: string;
    formatted_phone_number?: string;
    international_phone_number?: string;
    address_components?: Array<{ long_name: string; short_name: string; types: string[] }>;
  };
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function buildQueryLocation(location: string) {
  const l = location.trim();
  // Swiss-first bias: if user didn't mention CH/Switzerland, append it
  if (/\b(ch|schweiz|switzerland)\b/i.test(l)) return l;
  return `${l}, Switzerland`;
}

function extractAddressParts(components: Array<{ long_name: string; short_name: string; types: string[] }> | undefined) {
  const get = (t: string) => components?.find((c) => c.types.includes(t));
  const locality = get("locality")?.long_name ?? null;
  const postalTown = get("postal_town")?.long_name ?? null;
  const admin1 = get("administrative_area_level_1")?.short_name ?? null;
  const country = get("country")?.short_name ?? null;
  const postcode = get("postal_code")?.long_name ?? null;
  const route = get("route")?.long_name ?? null;
  const streetNo = get("street_number")?.long_name ?? null;

  const street = route ? (streetNo ? `${route} ${streetNo}` : route) : null;

  return {
    address_street: street,
    address_postcode: postcode,
    address_locality: postalTown ?? locality,
    address_city: locality ?? postalTown,
    address_canton: admin1,
    address_country: country
  };
}

async function geocodeViewport(params: { query: string; apiKey: string; region: string; language: string }) {
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.search = new URLSearchParams({
    address: params.query,
    region: params.region,
    language: params.language,
    key: params.apiKey
  }).toString();

  const res = await fetch(url.toString());
  const json = (await res.json()) as GeocodeResponse;
  if (json.status !== "OK" || !json.results?.length) {
    throw new Error(`Geocoding failed: ${json.status}${json.error_message ? ` - ${json.error_message}` : ""}`);
  }

  return json.results[0].geometry.viewport;
}

function gridCenters(viewport: { northeast: LatLng; southwest: LatLng }, desiredCenters: number): LatLng[] {
  const latSpan = viewport.northeast.lat - viewport.southwest.lat;
  const lngSpan = viewport.northeast.lng - viewport.southwest.lng;
  if (latSpan <= 0 || lngSpan <= 0) {
    return [
      {
        lat: (viewport.northeast.lat + viewport.southwest.lat) / 2,
        lng: (viewport.northeast.lng + viewport.southwest.lng) / 2
      }
    ];
  }

  const n = Math.max(1, Math.ceil(Math.sqrt(desiredCenters)));
  const stepLat = latSpan / n;
  const stepLng = lngSpan / n;

  const centers: LatLng[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      centers.push({
        lat: viewport.southwest.lat + stepLat * (i + 0.5),
        lng: viewport.southwest.lng + stepLng * (j + 0.5)
      });
    }
  }
  return centers;
}

function estimateRadiusMeters(viewport: { northeast: LatLng; southwest: LatLng }, centersCount: number) {
  // Rough conversion: 1° lat ≈ 111km; 1° lng ≈ 85km in CH (cos(lat) factor)
  const latSpan = viewport.northeast.lat - viewport.southwest.lat;
  const lngSpan = viewport.northeast.lng - viewport.southwest.lng;
  const side = Math.max(1, Math.ceil(Math.sqrt(centersCount)));
  const cellLatDeg = latSpan / side;
  const cellLngDeg = lngSpan / side;
  const cellLatM = cellLatDeg * 111_000;
  const cellLngM = cellLngDeg * 85_000;
  const approxHalf = Math.floor(Math.min(cellLatM, cellLngM) / 2);
  // Nearby search radius max is 50km; keep it conservative.
  return clamp(approxHalf || 10_000, 2_000, 20_000);
}

async function nearbySearch(params: {
  apiKey: string;
  location: LatLng;
  radius: number;
  keyword: string;
  region: string;
  language: string;
  pagetoken?: string;
}) {
  const url = new URL("https://maps.googleapis.com/maps/api/place/nearbysearch/json");
  const sp = new URLSearchParams({
    location: `${params.location.lat},${params.location.lng}`,
    radius: String(params.radius),
    keyword: params.keyword,
    language: params.language,
    region: params.region,
    key: params.apiKey
  });
  if (params.pagetoken) sp.set("pagetoken", params.pagetoken);
  url.search = sp.toString();

  const res = await fetch(url.toString());
  const json = (await res.json()) as NearbySearchResponse;
  if (json.status !== "OK" && json.status !== "ZERO_RESULTS") {
    throw new Error(`Nearby search failed: ${json.status}${json.error_message ? ` - ${json.error_message}` : ""}`);
  }
  return json;
}

async function placeDetails(params: { apiKey: string; placeId: string; region: string; language: string }) {
  const url = new URL("https://maps.googleapis.com/maps/api/place/details/json");
  url.search = new URLSearchParams({
    place_id: params.placeId,
    // Keep fields tight to control billing and payload size.
    fields: "name,website,formatted_phone_number,international_phone_number,address_components",
    language: params.language,
    region: params.region,
    key: params.apiKey
  }).toString();

  const res = await fetch(url.toString());
  const json = (await res.json()) as PlaceDetailsResponse;
  if (json.status !== "OK") {
    throw new Error(`Place details failed: ${json.status}${json.error_message ? ` - ${json.error_message}` : ""}`);
  }
  return json.result;
}

export async function googlePlacesLegacyDiscover(params: {
  industry: string;
  location: string;
  limit: number;
  apiKey: string;
  region: string;
  language: string;
}): Promise<CandidateCompany[]> {
  const queryLocation = buildQueryLocation(params.location);
  const viewport = await geocodeViewport({
    query: queryLocation,
    apiKey: params.apiKey,
    region: params.region,
    language: params.language
  });

  // Each nearby search yields at most ~60 results (3 pages). To reach 1k+ we must fan out by geography.
  const centersWanted = clamp(Math.ceil(params.limit / 40), 1, 225);
  const centers = gridCenters(viewport, centersWanted);
  const radius = estimateRadiusMeters(viewport, centers.length);

  const placeIds = new Set<string>();
  for (const c of centers) {
    // First page
    const first = await nearbySearch({
      apiKey: params.apiKey,
      location: c,
      radius,
      keyword: params.industry,
      region: params.region,
      language: params.language
    });
    first.results.forEach((r) => placeIds.add(r.place_id));

    // Optional pagination (Google requires a short delay before next_page_token becomes valid)
    let token = first.next_page_token;
    for (let page = 0; page < 2 && token; page++) {
      await sleep(1800);
      const next = await nearbySearch({
        apiKey: params.apiKey,
        location: c,
        radius,
        keyword: params.industry,
        region: params.region,
        language: params.language,
        pagetoken: token
      });
      next.results.forEach((r) => placeIds.add(r.place_id));
      token = next.next_page_token;
    }

    if (placeIds.size >= params.limit * 2) break; // de-dupe shrink happens later
  }

  const uniquePlaceIds = Array.from(placeIds).slice(0, params.limit);
  const candidates: CandidateCompany[] = [];

  for (const placeId of uniquePlaceIds) {
    const d = await placeDetails({ apiKey: params.apiKey, placeId, region: params.region, language: params.language });
    const addr = extractAddressParts(d.address_components);

    candidates.push({
      company_name: d.name ?? `Place ${placeId}`,
      company_website: d.website ?? null,
      company_phone: d.international_phone_number ?? d.formatted_phone_number ?? null,
      company_email: null,
      ...addr
    });
  }

  return candidates;
}
