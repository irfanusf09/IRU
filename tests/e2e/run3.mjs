// End-to-end check of the attendance app against local Firestore + Auth emulators.
import { chromium } from "playwright";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import fs from "fs"; import path from "path";
import { tagAll } from "./tagall.mjs";
import { PUBLIC, RULES, FB, XLSX_FILE, SHOTS } from "./paths.mjs";

const SUBJ = "1700000000001";
const STU = Array.from({ length: 40 }, (_, i) => 1700000000100 + i + 0.5);
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
  for (const [i, id] of STU.entries()) await set(`students/${id}`, { id, name: i === 0 ? "Student One" : `Student ${i + 1}`, roll: String(i + 1), batchId: 1700000000000, status: "ACTIVE", ...(i === 0 ? { uid: uids.s1, loginId: "s1" } : {}) });
  // Attendance saved BEFORE this update (so no student copies exist for it)
  await set(`attendance/${SUBJ}_2026-10-13`, { subjectId: SUBJ, date: "2026-10-13", records: Object.fromEntries(STU.map(s => [String(s), "Present"])), markedBy: "T1" });
  await set(`attendance/${SUBJ}_2026-10-14`, { subjectId: SUBJ, date: "2026-10-14", records: Object.fromEntries(STU.map(s => [String(s), "Absent"])), markedBy: "T1" });
  await set("correctionRequests/555", { id: 555, subjectId: SUBJ, date: "2026-10-14", studentId: ME, oldStatus: "Absent", requestedStatus: "Present", reason: "Was present", requestedBy: "T1", requestedAt: "2026-10-15T10:00:00Z", status: "pending" });
});

await tagAll(admin);

// ---------- browser ----------
const browser = await chromium.launch({ args: ["--no-proxy-server", "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults"] });
const ctx = await browser.newContext({ serviceWorkers: "block" });
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
async function logout() { if (await page.isVisible("#menuToggle") && !(await page.isVisible("#logoutBtn"))) await page.click("#menuToggle"); await page.click("#logoutBtn"); await page.waitForLoadState("load"); await page.waitForTimeout(300); }
const views = async () => { const out = {}; await admin(async db => (await db.collection("studentViews").get()).forEach(d => { out[d.id] = d.data(); })); return out; };
async function studentDashboard() {
  await login("s1");
  await page.waitForFunction(() => /Microeconomics/.test(document.getElementById("studentDashboardOutput").textContent), null, { timeout: 15000 });
  const row = await page.textContent("#studentDashboardOutput tr:has-text('Microeconomics')");
  await logout();
  return row.replace(/\s+/g, " ").trim();
}


const row = id => `#attendanceTable tr[data-student-id="${id}"]`;
const status = async id => page.getAttribute(row(id), "data-status");
const count = async () => (await page.textContent("#attendanceCountBox")).trim();
const statuses = async () => page.$$eval("#attendanceTable tbody tr", trs => trs.map(t => t.dataset.status));

await page.setViewportSize({ width: 390, height: 844 });
log("Teacher marking screen (phone)");
await login("t1");
await page.selectOption("#subjectSelect", SUBJ);
// Two changes in quick succession (the old double-button glitch)
await page.fill("#attendanceDate", "2026-10-19");
await page.dispatchEvent("#attendanceDate", "change");
await page.waitForSelector("#attendanceTable");
await page.waitForTimeout(800);
check("only one 'Mark Class Not Held' button after quick changes", (await page.$$("#attendanceTopBar button")).length === 1);
check("'Mark Class Not Held' is the quiet style", await page.$eval("#attendanceTopBar button", b => b.classList.contains("quiet-danger")));

// Sticky save bar: with 40 students the bar sits at the bottom of the screen
const bar = await page.$eval("#attendanceSaveBar", el => { const r = el.getBoundingClientRect(); return { bottom: r.bottom, top: r.top }; });
check("Save bar is visible at the bottom of the phone screen", bar.bottom <= 844 && bar.bottom > 760, JSON.stringify(bar));
await page.screenshot({ path: `${SHOTS}/new-phone-marking-top.png` });

const rolls = await page.$$eval("#attendanceTable tbody tr td:nth-child(2)", tds => tds.map(t => Number(t.textContent)));
check("rolls in number order (1, 2, 3 …)", rolls.every((r, i) => i === 0 || r > rolls[i - 1]), rolls.slice(0, 12).join(","));
check("everyone starts Present", (await count()) === "Present: 40 | Absent: 0");
await page.click(row(STU[2]) + " td:nth-child(3)");
check("tap a row -> Absent", (await status(STU[2])) === "Absent" && (await count()) === "Present: 39 | Absent: 1");
await page.click(row(STU[2]) + " td:nth-child(1)");
check("tap again -> Present", (await status(STU[2])) === "Present" && (await count()) === "Present: 40 | Absent: 0");

// Leave via its own button; the tap must not also toggle the row
await page.click(row(STU[4]) + " button:has-text('Leave')");
await page.waitForSelector("#uiDialog.open .ui-choice"); await page.click("#uiDialog.open .ui-choice:has-text('Medical')");
await page.waitForTimeout(150); await page.waitForSelector("#uiDialog.open"); await ok();
check("Leave… records a leave", (await status(STU[4])) === "Leave" && (await count()) === "Present: 39 | Absent: 0 | Leave: 1");

await page.click("#allAbsentBtn");
let st = await statuses();
check("All absent: everyone absent except the leave", st.filter(s => s === "Absent").length === 39 && st.filter(s => s === "Leave").length === 1);
await page.click("#allPresentBtn");
st = await statuses();
check("All present: everyone present except the leave", st.filter(s => s === "Present").length === 39 && (await status(STU[4])) === "Leave");

// Mark three absent, scroll down, check the bar is still on screen, save
for (const i of [1, 7, 30]) await page.click(row(STU[i]) + " td:nth-child(3)");
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
await page.waitForTimeout(200);
const bar2 = await page.$eval("#attendanceSaveBar", el => el.getBoundingClientRect().bottom);
check("Save bar still visible after scrolling half-way", bar2 <= 844 && bar2 > 760, String(bar2));
await page.screenshot({ path: `${SHOTS}/new-phone-marking-scrolled.png` });
await page.click("#saveBtn");
const msg = await dialog(); await ok();
check("save succeeds with the right counts", /saved successfully/.test(msg) && /Present: 36 \| Absent: 3 \| Leave: 1/.test(msg), JSON.stringify(msg));
let saved = null; await admin(async db => { saved = (await db.doc(`attendance/${SUBJ}_2026-10-19`).get()).data(); });
check("saved record: 36 Present, 4 Absent (leave = Absent + leave record)",
  Object.values(saved.records).filter(v => v === "Present").length === 36 && Object.values(saved.records).filter(v => v === "Absent").length === 4);
let lv = false; await admin(async db => { lv = (await db.doc(`leaves/${SUBJ}_2026-10-19_${STU[4]}`).get()).exists; });
check("leave record saved", lv);

// After saving: still editable for a while (edit window)
await page.waitForSelector("#attendanceSaveBar.saved");
check("after save: 'Save changes' shown, disabled until a change", await page.isVisible("#saveBtn") && await page.isDisabled("#saveBtn") &&
  /Save changes/.test(await page.textContent("#saveBtn")) && /until/.test(await page.textContent("#saveStatus")));
check("after save: no 'Mark Class Not Held' and no All buttons", (await page.$$("#attendanceTopBar button")).length === 0 && !(await page.$("#allPresentBtn")));
await page.click(row(STU[0]) + " td:nth-child(3)");
check("after save: tapping a row changes it and marks it", (await status(STU[0])) === "Absent" &&
  await page.$eval(row(STU[0]), tr => tr.classList.contains("is-changed")) && !(await page.isDisabled("#saveBtn")));
await page.click(row(STU[0]) + " td:nth-child(3)");
check("tapping back undoes it", (await status(STU[0])) === "Present" && await page.isDisabled("#saveBtn"));
check("absent rows still offer Mark Leave", await page.isVisible(row(STU[1]) + " button:has-text('Mark Leave')"));
check("no Request Correction during the window", !(await page.$(row(STU[0]) + " button:has-text('Request Correction')")));
await page.evaluate(() => window.scrollTo(0, 0));
await page.screenshot({ path: `${SHOTS}/new-phone-saved.png` });

// Sunday: no leftover button from the previous date
await page.fill("#attendanceDate", "2026-10-20");
await page.waitForSelector("#attendanceTopBar button");
await page.fill("#attendanceDate", "2026-10-18");
await page.waitForFunction(() => /Day is closed/.test(document.getElementById("student-list").textContent));
check("closed day: no leftover 'Mark Class Not Held', no Save bar",
  (await page.$$("#attendanceTopBar button")).length === 0 && !(await page.isVisible("#attendanceSaveBar")));
await logout();

// Desktop look
await page.setViewportSize({ width: 1366, height: 800 });
await login("t1");
await page.selectOption("#subjectSelect", SUBJ);
await page.fill("#attendanceDate", "2026-10-20");
await page.waitForSelector("#attendanceTable");
for (const i of [3, 9]) await page.click(row(STU[i]) + " td:nth-child(3)");
await page.screenshot({ path: `${SHOTS}/new-desktop-marking.png` });
await logout();

// HOD: view only
log("HOD view");
await login("hod");
await page.evaluate(() => showSection("attendanceSection"));
await page.selectOption("#subjectSelect", SUBJ);
await page.fill("#attendanceDate", "2026-10-19");
await page.waitForSelector("#attendanceTable");
await page.click(row(STU[0]) + " td:nth-child(3)");
check("HOD: rows don't toggle, no Save, 'View Only' shown, no tools",
  (await status(STU[0])) === "Present" && !(await page.isVisible("#saveBtn")) && (await page.isVisible("#viewOnlyBtn")) &&
  !(await page.$("#allPresentBtn")) && (await page.$$("#attendanceTopBar button")).length === 0);
await logout();

const real = errors.filter(e => !/Failed to load resource.*404|favicon|manifest/i.test(e));
check("no errors in the browser console", real.length === 0, real.join("\n    "));
await browser.close(); await env.cleanup();
console.log(failures ? `\n${failures} check(s) FAILED` : "\nALL CHECKS PASSED");
process.exit(failures ? 1 : 0);
