import { z } from "zod";

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  APP_BASE_URL: z.string().default("http://localhost:3000"),

  // Optional: enable real discovery via Google Places / Geocoding
  GOOGLE_MAPS_API_KEY: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z.string().min(1).optional()
  ),
  GOOGLE_PLACES_REGION: z.string().default("ch"),
  GOOGLE_PLACES_LANGUAGE: z.string().default("de"),

  CRAWL_MAX_PAGES: z.coerce.number().int().min(1).max(30).optional().default(4),
  CRAWL_FETCH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).optional().default(8000),
  ENRICH_CONCURRENCY: z.coerce.number().int().min(1).max(10).optional().default(3),
  ENRICH_LEAD_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300000).optional().default(30000),

  ENABLE_BROWSER_CRAWL: z.string().optional().default("1"),

  ENABLE_LLM: z.string().optional().default("0"),
  LLM_PROVIDER: z.string().optional().default(""),
  LLM_API_KEY: z.string().optional().default("")
});


export const env = EnvSchema.parse(process.env);
export const isLlmEnabled = env.ENABLE_LLM === "1";
