import path from "path";
// How long screens take when every database read costs ~250 ms (India <-> USA).
import { start } from "./harness.mjs";
import { execFileSync } from "node:child_process";
import { TOOLS } from "./paths.mjs";
const LAT = Number(process.env.LAT || 250);
const h = await start({ latency: LAT });
const { page } = h;
const env = { ...process.env, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" };
execFileSync("node", ["seed.mjs", "--project", "demo-attendance"], { cwd: path.join(TOOLS, "demo-seed"), env });
const results = [];
async function time(label, action, ready) {
  await page.evaluate(() => { window.__reads = 0; window.__log = []; });
  const t = Date.now();
  await action();
  await page.waitForFunction(ready, null, { timeout: 120000 });
  await page.waitForTimeout(50);
  results.push([label, ((Date.now() - t) / 1000).toFixed(1) + " s", await page.evaluate(() => window.__reads)]);
  if (process.env.TRACE) {
    const log = await page.evaluate(() => window.__log || []);
    const t0 = log.length ? log[0][0] : 0;
    console.log(`\n### ${label}`);
    log.forEach(([ms, p]) => console.log(`  +${String(ms - t0).padStart(5)} ms  ${p}`));
  }
}
const today = await page.evaluate(() => new Date().toLocaleDateString("en-CA"));
const yesterday = (() => { const d = new Date(Date.now() - 86400000); if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();

await time("HOD: log in → dashboard ready", () => h.login("hod.eco", "demo1234"),
  () => /Classes Today/.test(document.getElementById("hodStatsWidget").textContent) && !/Loading/.test(document.getElementById("hodDashToday").textContent));
await time("HOD: open Admin Panel (all lists)", () => page.evaluate(() => showSection("adminSection")),
  () => document.getElementById("teacherAssignmentList").children.length > 0 && document.querySelectorAll("#studentUploadSubjectSelect option[value]").length > 1);
await time("HOD: Reports, summary for one month", async () => {
  await page.evaluate(() => showSection("reportsSection"));
  await page.waitForFunction(() => document.querySelectorAll("#subjectFilter option").length > 1);
  await page.fill("#fromDate", "2026-10-01"); await page.fill("#toDate", "2026-10-31"); await page.click("#generateBtn");
}, () => !!document.querySelector("#reportOutput table"));
await h.logout();

await time("Teacher: log in → attendance screen", () => h.login("eco.asifa", "demo1234"),
  () => document.querySelectorAll("#subjectSelect option").length > 1);
await time("Teacher: pick subject + date → class list", async () => {
  await page.selectOption("#subjectSelect", { index: 1 }); await page.fill("#attendanceDate", yesterday);
}, () => !!document.querySelector("#attendanceTable tbody tr"));
await h.logout();

await time("Student: log in → dashboard", () => h.login("25001", "demo1234"),
  () => /Microeconomics/.test(document.getElementById("studentDashboardOutput").textContent));
await h.logout();

await time("Principal: log in → dashboard", () => h.login("principal", "demo1234"),
  () => !!document.querySelector("#principalOutput table"));
await h.logout();

console.log(`\nWith ${LAT} ms per database read:`);
results.forEach(([l, t, r]) => console.log(`  ${l.padEnd(45)} ${t.padStart(7)}   ${String(r).padStart(4)} reads`));
await h.finish();
