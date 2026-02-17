import * as cheerio from "cheerio";

export function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  // remove script/style
  $("script, style, noscript").remove();
  return $.text().replace(/\s+/g, " ").trim();
}

export function findLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const links: string[] = [];
  $("a[href]").each((_i, el) => {
    const href = String($(el).attr("href") ?? "").trim();
    if (!href) return;
    try {
      const u = new URL(href, baseUrl);
      if (u.protocol.startsWith("http")) links.push(u.toString());
    } catch {
      // ignore
    }
  });
  return links;
}
