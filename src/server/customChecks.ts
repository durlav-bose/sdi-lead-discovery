import { CustomCheck } from "./types";

/**
 * Parses a free-text list of custom checks.
 * Format examples:
 * - "Has booking calendar (boolean)"
 * - "Tech stack hints (text)"
 * - "Locations count (number)"
 */
export function parseCustomChecks(raw: string | null | undefined): {
  raw: string;
  checks: CustomCheck[];
} {
  const text = (raw ?? "").trim();
  if (!text) return { raw: "", checks: [] };

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const checks: CustomCheck[] = lines.map((line, idx) => {
    const m = line.match(/^(.*?)(?:\s*\((boolean|text|number|enum)\))?$/i);
    const name = (m?.[1] ?? line).trim();
    const type = (m?.[2]?.toLowerCase() as any) ?? "boolean";
    return {
      id: `c${idx + 1}`,
      name,
      type,
      description: line
    };
  });

  return { raw: text, checks };
}
