// "Rebuild student copies" on a realistic amount of data (the demo college):
// it once failed because too many class summaries were saved at once.
import { start } from "./harness.mjs";
import { execFileSync } from "node:child_process";
import path from "path";
import { TOOLS } from "./paths.mjs";
const h = await start();
const { page, check, log, admin } = h;
execFileSync("node", ["seed.mjs", "--project", "demo-attendance"], { cwd: path.join(TOOLS, "demo-seed"),
  env: { ...process.env, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" } });
const count = async c => { let n; await admin(async db => { n = (await db.collection(c).get()).size; }); return n; };
for (const hod of ["hod.eco", "hod.phy"]) {
  log(`${hod} rebuilds`);
  await h.login(hod, "demo1234");
  await page.evaluate(() => showSection("adminSection"));
  await page.click("#adminTabs button[data-tab=settings]");
  await page.click("#rebuildViewsBtn");
  await page.waitForFunction(() => /Rebuilt|FAILED/.test(document.getElementById("rebuildViewsStatus").textContent), null, { timeout: 60000 });
  const status = await page.textContent("#rebuildViewsStatus");
  check("rebuild succeeds", /Rebuilt \d+/.test(status), status);
  await h.logout();
}
check("class summaries cover every saved class", (await count("classSummaries")) >= (await count("attendance")) - 0,
  `${await count("classSummaries")} summaries, ${await count("attendance")} attendance`);
await h.finish();
