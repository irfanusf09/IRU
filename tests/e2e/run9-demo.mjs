// The demo seed script, then a look around as Principal, HOD, teacher and student.
import path from "path";
import { start, SHOTS } from "./harness.mjs";
import { execFileSync } from "node:child_process";
import { TOOLS } from "./paths.mjs";
const h = await start();
const { page, check, log } = h;
const seedDir = path.join(TOOLS, "demo-seed");
const env = { ...process.env, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" };
const run = () => { try { return execFileSync("node", ["seed.mjs", "--project", "demo-attendance"], { cwd: seedDir, env, encoding: "utf8" }); }
                    catch (e) { return (e.stdout || "") + (e.stderr || ""); } };
log("Seed an empty project");
const out1 = run();
check("seed finished and printed the logins", /Demo logins/.test(out1) && /principal/.test(out1), out1.slice(-500));
const out2 = run();
check("a second run refuses (project not empty)", /Refusing/.test(out2), out2.trim());

log("Principal");
await h.login("principal", "demo1234");
await page.waitForSelector("#principalOutput .stat-row", { timeout: 20000 });
await page.fill("#principalDate", (await page.inputValue("#principalDate")));
const yesterday = await page.evaluate(() => { const d = new Date(Date.now() + 330 * 60000 - 86400000); if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); });
await page.fill("#principalDate", yesterday); await page.dispatchEvent("#principalDate", "change");
await page.waitForTimeout(1500);
await page.waitForSelector("#principalOutput table");
const held = Number(await page.textContent("#principalOutput .stat b"));
check("yesterday: classes held across departments", held > 0, String(held));
await page.click("#principalTodayBtn"); await page.waitForTimeout(1500);
await page.click("#principalNotMarkedBtn");
await page.waitForFunction(() => document.getElementById("principalNotMarked").textContent.trim().length > 12, null, { timeout: 15000 });
await page.screenshot({ path: `${SHOTS}/demo-principal-today.png`, fullPage: true });
await page.fill("#principalDate", yesterday); await page.dispatchEvent("#principalDate", "change");
await page.waitForTimeout(1500);
await page.evaluate(() => document.querySelectorAll("details.dept-classes").forEach(d => d.open = true));
await page.screenshot({ path: `${SHOTS}/demo-principal.png`, fullPage: true });
await h.logout();

log("HOD Economics: defaulters and register");
await h.login("hod.eco", "demo1234");
await page.waitForFunction(() => /Classes Today/.test(document.getElementById("hodStatsWidget").textContent), null, { timeout: 15000 });
check("HOD dashboard: 30 active students", /30\s*Active Students/.test(await page.textContent("#hodStatsWidget")));
await page.evaluate(() => showSection("defaultersSection"));
await page.waitForFunction(() => document.querySelectorAll("#defaulterBatchSelect option").length > 1);
await page.selectOption("#defaulterBatchSelect", { label: (await page.$$eval("#defaulterBatchSelect option", os => os.map(o => o.textContent))).find(t => /Microeconomics/.test(t)) });
await page.click("#generateDefaultersBtn");
await page.waitForSelector("#defaultersOutput table, #defaultersOutput p");
await page.waitForTimeout(1500);
check("Microeconomics has defaulters", !!(await page.$("#defaultersOutput table")), (await page.textContent("#defaultersOutput")).replace(/\s+/g, " ").slice(0, 300) + " | selected: " + await page.$eval("#defaulterBatchSelect", s => s.options[s.selectedIndex].text));
await h.logout();

log("Student 25001 (Economics, takes a Physics Minor)");
await h.login("25001", "demo1234");
await page.waitForFunction(() => /Physics for Economists/.test(document.getElementById("studentDashboardOutput").textContent), null, { timeout: 20000 });
const d = (await page.textContent("#studentDashboardOutput")).replace(/\s+/g, " ");
check("three subjects incl. the Physics Minor", /Microeconomics/.test(d) && /Indian Economy/.test(d) && /Physics for Economists/.test(d), d.slice(0, 250));
await page.screenshot({ path: `${SHOTS}/demo-student.png`, fullPage: true });
await h.logout();
await h.finish();
