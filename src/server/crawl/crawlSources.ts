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

export type CrawlSourceConfig = {
  version: number;
  sources: Array<{
    name: string;
    enabled?: boolean;
    urlTemplate: string;
  }>;
};

type Cache = { loadedAt: number; config: CrawlSourceConfig };
let cache: Cache | null = null;

const CACHE_TTL_MS = 30_000;

export function loadCrawlSourcesConfig(): CrawlSourceConfig {
  const now = Date.now();
  if (cache && now - cache.loadedAt < CACHE_TTL_MS) return cache.config;

  const root = findProjectRoot(process.cwd());
  const filePath = path.join(root, "crawl-sources.json");
  if (!fs.existsSync(filePath)) {
    const empty: CrawlSourceConfig = { version: 1, sources: [] };
    cache = { loadedAt: now, config: empty };
    return empty;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw) as CrawlSourceConfig;
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).sources)) {
    const empty: CrawlSourceConfig = { version: 1, sources: [] };
    cache = { loadedAt: now, config: empty };
    return empty;
  }

  const cfg: CrawlSourceConfig = {
    version: typeof parsed.version === "number" ? parsed.version : 1,
    sources: (parsed.sources ?? []).filter((s: any) => s && typeof s.urlTemplate === "string" && typeof s.name === "string")
  };

  cache = { loadedAt: now, config: cfg };
  return cfg;
}

export function expandUrlTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_m, keyRaw) => {
    const key = String(keyRaw);
    if (key in vars) return vars[key] ?? "";

    if (key.endsWith("Encoded")) {
      const base = key.slice(0, -"Encoded".length);
      return encodeURIComponent(vars[base] ?? "");
    }

    if (key.endsWith("_url")) {
      const base = key.slice(0, -"_url".length);
      return encodeURIComponent(vars[base] ?? "");
    }

    return "";
  });
}
