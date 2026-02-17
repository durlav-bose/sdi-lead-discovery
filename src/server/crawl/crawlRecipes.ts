import fs from "node:fs";
import path from "node:path";

function findProjectRoot(startDir: string) {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const pkg = path.join(dir, "package.json");
    if (fs.existsSync(pkg)) return dir;
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return startDir;
}

export type CrawlRecipeStep =
  | { type: "goto" }
  | { type: "waitForSelector"; selector: string; timeoutMs?: number }
  | { type: "waitForTimeout"; ms: number }
  | { type: "fill"; selector: string; valueTemplate: string }
  | { type: "click"; selector: string }
  | { type: "extractText"; selector: string; field: string };

export type CrawlRecipe = {
  name: string;
  enabled?: boolean;
  startUrlTemplate: string;
  maxSteps?: number;
  steps: CrawlRecipeStep[];
};

export type CrawlRecipesConfig = {
  version: number;
  enabled?: boolean;
  recipes: CrawlRecipe[];
};

type Cache = { loadedAt: number; config: CrawlRecipesConfig };
let cache: Cache | null = null;
const CACHE_TTL_MS = 30_000;

export function loadCrawlRecipesConfig(): CrawlRecipesConfig {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) return cache.config;

  const root = findProjectRoot(process.cwd());
  const filePath = path.join(root, "crawl-recipes.json");
  if (!fs.existsSync(filePath)) {
    const empty: CrawlRecipesConfig = { version: 1, enabled: false, recipes: [] };
    cache = { loadedAt: now, config: empty };
    return empty;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as CrawlRecipesConfig;

  const cfg: CrawlRecipesConfig = {
    version: typeof parsed?.version === "number" ? parsed.version : 1,
    enabled: Boolean((parsed as any)?.enabled),
    recipes: Array.isArray((parsed as any)?.recipes) ? ((parsed as any).recipes as any[]) : []
  };

  cache = { loadedAt: now, config: cfg };
  return cfg;
}
