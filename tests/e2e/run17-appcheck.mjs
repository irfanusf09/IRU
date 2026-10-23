// App Check: with a site key filled in, it starts on BOTH Firebase connections
// (the second one creates logins) and the app works as before.
// (Real reCAPTCHA can't run here; the harness stands in for it. Note: if a
// browser can't reach Google's reCAPTCHA at all, the app does not load.)
import { start } from "./harness.mjs";
import { execFileSync } from "node:child_process";
import path from "path";
import { TOOLS } from "./paths.mjs";
const h = await start({ host: "attendance.example.test", appCheckKey: "site-key-for-test" });
const { page, check, log } = h;
const env = { ...process.env, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" };
execFileSync("node", ["seed.mjs", "--project", "demo-attendance"], { cwd: path.join(TOOLS, "demo-seed"), env });
const starts = () => page.evaluate(() => window.__appCheck || []);

log("HOD logs in");
await h.login("hod.eco", "demo1234");
await page.waitForFunction(() => /Classes Today/.test(document.getElementById("hodStatsWidget").textContent));
check("app works", true);
check("App Check started once, with the site key", JSON.stringify(await starts()) === JSON.stringify(["site-key-for-test"]), JSON.stringify(await starts()));

log("HOD creates a teacher login (second connection)");
await page.evaluate(() => showSection("adminSection"));
await page.waitForFunction(() => document.getElementById("teacherAssignmentList").children.length > 0);
await page.click("#adminTabs button[data-tab=teachers]");
await page.fill("#teacherNameInput", ""); await page.type("#teacherNameInput", "Appcheck Test");
await page.waitForTimeout(800);
await page.fill("#teacherPasswordInput", "start123");
await page.click("#addTeacherBtn");
const msg = await h.alertText();
check("teacher login created", /Teacher added/.test(msg), msg.slice(0, 80));
check("App Check started on the login-creating connection too", (await starts()).length === 2, JSON.stringify(await starts()));
await h.finish();
