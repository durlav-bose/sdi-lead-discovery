import { chromium } from "playwright";

const query = process.argv[2] ?? "Limmat";

const b = await chromium.launch({ headless: true });
const p = await b.newPage();

await p.goto("https://www.uid.admin.ch/Search.aspx?lang=en", {
  waitUntil: "domcontentloaded",
  timeout: 30000
});

await p.fill("#cphContent_ctl02_txtSearch", query);
await Promise.all([
  p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {}),
  p.click("#cphContent_btnSearch", { timeout: 30000 })
]);

await p.waitForTimeout(2000);

const tableSel = "#ctl00_cphContent_gridSearchresult_ctl00";
await p.waitForSelector(tableSel, { timeout: 30000 });

const firstRowLinkSel = `${tableSel} tbody tr a[href^='javascript:__doPostBack']`;
await p.waitForSelector(firstRowLinkSel, { timeout: 30000 });

const firstLinkText = (await p.textContent(firstRowLinkSel))?.trim() ?? "";

await Promise.all([
  p.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {}),
  p.click(firstRowLinkSel, { timeout: 30000 })
]);

await p.waitForTimeout(2500);

const url = p.url();
const title = await p.title();
const bodyHead = ((await p.textContent("body")) ?? "").trim().slice(0, 700);

const tables = await p.$$eval("table", (els) =>
  els
    .map((t) => ({
      id: t.id,
      cls: t.className,
      rows: t.querySelectorAll("tr").length,
      text: (t.innerText || "").trim().replace(/\s+/g, " ").slice(0, 200)
    }))
    .filter((x) => x.rows > 1)
    .sort((a, b) => b.rows - a.rows)
    .slice(0, 10)
);

console.log(
  JSON.stringify(
    {
      query,
      firstLinkText,
      url,
      title,
      bodyHead,
      tables
    },
    null,
    2
  )
);

await b.close();
