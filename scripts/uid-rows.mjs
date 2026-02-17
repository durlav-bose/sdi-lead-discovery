import { chromium } from "playwright";

const query = process.argv[2] ?? "Limmat";

const b = await chromium.launch({ headless: true });
const p = await b.newPage();
await p.goto("https://www.uid.admin.ch/Search.aspx?lang=en", { waitUntil: "domcontentloaded", timeout: 30000 });
await p.fill("#cphContent_ctl02_txtSearch", query);
await Promise.all([
  p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {}),
  p.click("#cphContent_btnSearch", { timeout: 30000 })
]);
await p.waitForTimeout(2000);

const tableSel = "#ctl00_cphContent_gridSearchresult_ctl00";
await p.waitForSelector(tableSel, { timeout: 30000 });

const rows = await p.$$eval(`${tableSel} tbody tr`, (trs) => {
  const out = [];
  for (let i = 0; i < Math.min(5, trs.length); i++) {
    const tr = trs[i];
    const cells = Array.from(tr.querySelectorAll("td")).map((td) =>
      (td.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120)
    );
    const links = Array.from(tr.querySelectorAll("a")).map((a) => ({
      text: (a.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120),
      href: a.getAttribute("href") || "",
      id: a.id || "",
      cls: a.className || ""
    }));
    out.push({ i, cells, links });
  }
  return out;
});

console.log(JSON.stringify({ query, rows }, null, 2));
await b.close();
