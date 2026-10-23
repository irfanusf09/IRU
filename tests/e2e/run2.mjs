// End-to-end check of the attendance app against local Firestore + Auth emulators.
import { chromium } from "playwright";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import fs from "fs"; import path from "path";
import { tagAll } from "./tagall.mjs";
import { PUBLIC, RULES, FB, XLSX_FILE } from "./paths.mjs";

const SUBJ = "1700000000001";
const TODAY = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const STU = [1700000000100.25, 1700000000101.5, 1700000000102.75];
const ME = STU[0], MEs = String(ME);
const log = (...a) => console.log("•", ...a);
let failures = 0;
const check = (name, cond, extra = "") => { console.log(cond ? "  PASS" : "  FAIL", name, extra); if (!cond) failures++; };

// ---------- seed ----------
async function signUp(email) {
  const r = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "secret123", returnSecureToken: true }) });
  return (await r.json()).localId;
}
const env = await initializeTestEnvironment({ projectId: "demo-attendance", firestore: { rules: fs.readFileSync(RULES, "utf8"), host: "127.0.0.1", port: 8080 } });
const admin = async fn => env.withSecurityRulesDisabled(ctx => fn(ctx.firestore()));
const uids = {};
for (const who of ["hod", "t1", "s1"]) uids[who] = await signUp(`${who}@users.attendance.example.com`);
await admin(async db => {
  const set = (p, d) => db.doc(p).set(d);
  await set("config/hod", { uid: uids.hod });
  await set(`users/${uids.hod}`, { role: "HOD", name: "Head", loginId: "hod", active: true, mustChangePassword: false });
  await set(`users/${uids.t1}`, { role: "Teacher", name: "Asha Bhat", loginId: "t1", teacherId: "T1", active: true, mustChangePassword: false });
  await set(`users/${uids.s1}`, { role: "Student", name: "Student One", loginId: "s1", studentId: ME, studentDocId: MEs, roll: "1", active: true, mustChangePassword: false });
  for (const who of ["hod", "t1", "s1"]) await set(`loginNames/${who}`, { email: `${who}@users.attendance.example.com`, uid: uids[who] });
  await set("teachers/T1", { id: "T1", name: "Asha Bhat", username: "t1", loginId: "t1", uid: uids.t1, status: "ACTIVE" });
  await set("batches/1700000000000_3", { id: 1700000000000, program: "UG", year: 2025, semester: "3", status: "ACTIVE" });
  await set(`subjects/${SUBJ}`, { id: Number(SUBJ), name: "Microeconomics", batchId: 1700000000000, type: "MAJOR", program: "UG", semester: "3", year: 2025 });
  await set(`subjectAssignments/${SUBJ}`, { subjectId: SUBJ, teacherId: "T1", history: [] });
  await set(`enrollments/${SUBJ}`, { subjectId: SUBJ, students: STU });
  for (const [i, id] of STU.entries()) await set(`students/${id}`, { id, name: `Student ${["One", "Two", "Three"][i]}`, roll: String(i + 1), batchId: 1700000000000, status: "ACTIVE", ...(i === 0 ? { uid: uids.s1, loginId: "s1" } : {}) });
  // Attendance saved BEFORE this update (so no student copies exist for it)
  await set(`attendance/${SUBJ}_2026-10-13`, { subjectId: SUBJ, date: "2026-10-13", records: Object.fromEntries(STU.map(s => [String(s), "Present"])), markedBy: "T1" });
  await set(`attendance/${SUBJ}_2026-10-14`, { subjectId: SUBJ, date: "2026-10-14", records: Object.fromEntries(STU.map(s => [String(s), "Absent"])), markedBy: "T1" });
  await set(`attendance/${SUBJ}_${TODAY}`, { subjectId: SUBJ, date: TODAY, records: { [String(STU[0])]: "P", [String(STU[1])]: "present", [String(STU[2])]: "A" }, markedBy: "T1" });
  await set("correctionRequests/555", { id: 555, subjectId: SUBJ, date: "2026-10-14", studentId: ME, oldStatus: "Absent", requestedStatus: "Present", reason: "Was present", requestedBy: "T1", requestedAt: "2026-10-15T10:00:00Z", status: "pending" });
});

await tagAll(admin);

// ---------- browser ----------
const browser = await chromium.launch({ args: ["--no-proxy-server", "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults"] });
const ctx = await browser.newContext({ serviceWorkers: "block", timezoneId: "America/New_York" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", e => errors.push("pageerror: " + e.message));
page.on("console", m => { if (m.type() === "error" || /permission|denied/i.test(m.text())) errors.push(`${m.type()}: ${m.text()}`); });
const TYPES = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
await page.route("**/*", async route => {
  const url = new URL(route.request().url());
  if (url.hostname === "www.gstatic.com") return route.fulfill({ path: path.join(FB, path.basename(url.pathname)), contentType: "text/javascript" });
  if (url.hostname === "cdn.sheetjs.com") return route.fulfill({ path: XLSX_FILE, contentType: "text/javascript" });
  if (url.hostname === "cdn.jsdelivr.net" || url.hostname === "cdnjs.cloudflare.com") return route.fulfill({ body: "", contentType: "text/javascript" });
  if (url.host === "localhost:5555") {
    if (url.pathname === "/firebase-config.js") return route.fulfill({ contentType: "text/javascript", body: `
      const firebaseConfig = { apiKey: "fake", authDomain: "demo-attendance.firebaseapp.com", projectId: "demo-attendance", appId: "1:1:web:1" };
      (function () { const orig = firebase.initializeApp.bind(firebase);
        firebase.initializeApp = function (cfg, name) { const app = orig(cfg, name);
          app.firestore().useEmulator("127.0.0.1", 8080); app.auth().useEmulator("http://127.0.0.1:9099", { disableWarnings: true }); return app; }; })();` });
    const file = path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ path: file, contentType: TYPES[path.extname(file)] || "application/octet-stream" });
  }
  return route.continue();
});

const dialog = async () => { await page.waitForSelector("#uiDialog.open"); return page.textContent("#uiDialog .ui-msg"); };
const ok = async () => { await page.click("#uiDialog.open .ui-ok"); await page.waitForSelector("#uiDialog.open", { state: "detached", timeout: 500 }).catch(() => {}); await page.waitForTimeout(150); };
async function login(id) {
  await page.goto("http://localhost:5555/");
  await page.waitForSelector("#loginScreen", { state: "visible" });
  await page.fill("#loginUsername", id); await page.fill("#loginPassword", "secret123");
  await page.click("#loginBtn");
  try { await page.waitForSelector("#appContainer", { state: "visible", timeout: 10000 }); }
  catch (e) { console.log("LOGIN FAILED:", await page.textContent("#loginError"), "\n", errors.join("\n")); throw e; }
}
async function logout() { await page.click("#logoutBtn"); await page.waitForLoadState("load"); await page.waitForTimeout(300); }
const views = async () => { const out = {}; await admin(async db => (await db.collection("studentViews").get()).forEach(d => { out[d.id] = d.data(); })); return out; };
async function studentDashboard() {
  await login("s1");
  await page.waitForFunction(() => /Microeconomics/.test(document.getElementById("studentDashboardOutput").textContent), null, { timeout: 15000 });
  const row = await page.textContent("#studentDashboardOutput tr:has-text('Microeconomics')");
  await logout();
  return row.replace(/\s+/g, " ").trim();
}


// A. Monday is not a Sunday, even in New York time
log("Teacher picks dates (browser in New York time)");
await login("t1");
await page.selectOption("#subjectSelect", SUBJ);
await page.fill("#attendanceDate", "2026-10-19"); await page.dispatchEvent("#attendanceDate", "change");
await page.waitForFunction(() => document.getElementById("attendanceTable") || /Day is closed/.test(document.getElementById("student-list").textContent));
check("Monday opens the register (not 'Day is closed')", !/Day is closed/.test(await page.textContent("#student-list")));
await page.fill("#attendanceDate", "2026-10-18"); await page.dispatchEvent("#attendanceDate", "change");
await page.waitForFunction(() => /Day is closed/.test(document.getElementById("student-list").textContent));
check("Sunday still shows 'Day is closed'", true);
await logout();

// B. HOD dashboard counts today's P / present / A
log("HOD dashboard");
await login("hod");
await page.waitForFunction(() => /Classes Today/.test(document.getElementById("hodStatsWidget").textContent), null, { timeout: 15000 });
const stats = (await page.textContent("#hodStatsWidget")).replace(/\s+/g, " ");
check("today: 1 class, 2 present, 1 absent", /1 Classes Today 2 Total Present 1 Total Absent/.test(stats), JSON.stringify(stats));

// C. Closed days: add and remove show up immediately
log("Day closures");
await page.evaluate(() => showSection("adminSection"));
await page.click("#adminTabs button[data-tab=closures]");
await page.fill("#closedDayDate", "2026-10-27");
await page.fill("#closedDayReason", "Snowfall");
await page.click("#addClosedDayBtn");
await page.waitForFunction(() => /2026-10-27/.test(document.getElementById("closedDayList").textContent), null, { timeout: 5000 }).catch(() => {});
check("added day appears in the list", /2026-10-27 — Snowfall/.test((await page.textContent("#closedDayList")).replace(/\s+/g, " ")));
let saved = false; await admin(async db => { saved = (await db.doc("dayStatuses/ECO_2026-10-27").get()).exists; });
check("added day is saved", saved);
await page.click("#closedDayList li:has-text('2026-10-27') button");
await page.waitForFunction(() => !/2026-10-27/.test(document.getElementById("closedDayList").textContent), null, { timeout: 5000 }).catch(() => {});
check("removed day disappears from the list", !/2026-10-27/.test(await page.textContent("#closedDayList")));
await admin(async db => { saved = (await db.doc("dayStatuses/ECO_2026-10-27").get()).exists; });
check("removed day is deleted", !saved);
await logout();

const real = errors.filter(e => !/Failed to load resource.*404|favicon|manifest/i.test(e));
check("no errors in the browser console", real.length === 0, real.join("\n    "));
await browser.close(); await env.cleanup();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
