import path from "path";
// Excel/PDF code loads only when used; a failed load gives a clear message.
import { start } from "./harness.mjs";
import { execFileSync } from "node:child_process";
import { TOOLS } from "./paths.mjs";
const h = await start();
const { page } = h;
const env = { ...process.env, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" };
execFileSync("node", ["seed.mjs", "--project", "demo-attendance"], { cwd: path.join(TOOLS, "demo-seed"), env });

h.log("HOD logs in");
await h.login("hod.eco", "demo1234");
h.check("Excel code not loaded at start", await page.evaluate(() => typeof XLSX === "undefined"));
h.check("PDF code not loaded at start", await page.evaluate(() => typeof html2pdf === "undefined"));

h.log("report → Excel export");
await page.evaluate(() => showSection("reportsSection"));
await page.waitForFunction(() => document.querySelectorAll("#subjectFilter option").length > 1);
await page.fill("#fromDate", "2026-10-01"); await page.fill("#toDate", "2026-10-31"); await page.click("#generateBtn");
await page.waitForSelector("#reportOutput table");
const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), page.click("#exportExcelBtn")]);
h.check("Excel file downloaded", dl.suggestedFilename() === "attendance_report.xlsx", dl.suggestedFilename());
h.check("Excel code now loaded", await page.evaluate(() => typeof XLSX !== "undefined"));
const n = await page.evaluate(() => document.querySelectorAll('script[src*="sheetjs"]').length);
const [dl2] = await Promise.all([page.waitForEvent("download", { timeout: 15000 }), page.click("#exportExcelBtn")]);
h.check("second export works, library fetched once", !!dl2 && n === 1 &&
  await page.evaluate(() => document.querySelectorAll('script[src*="sheetjs"]').length) === 1);

h.log("PDF export when the PDF code can't load (test serves an empty file)");
await page.click("#exportPdfBtn");
const msg = await h.alertText();
h.check("clear message", /Could not load the PDF tool/.test(msg), msg);
await h.finish();
