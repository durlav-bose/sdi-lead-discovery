const URL_REGEX = /(https?:\/\/[^\s,;]+)|(www\.[^\s,;]+)/gi;

export function extractUrlSeeds(text: string): string[] {
  const matches = text.match(URL_REGEX) ?? [];
  const urls = matches.map((m) => (m.startsWith("http") ? m : `https://${m}`));
  // basic de-dupe + normalize trailing punctuation
  const cleaned = urls
    .map((u) => u.replace(/[)\].,;]+$/g, "").trim())
    .filter((u) => /^https?:\/\//i.test(u));
  return Array.from(new Set(cleaned));
}
