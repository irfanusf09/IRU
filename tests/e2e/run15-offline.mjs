// Lost internet: screens say so instead of looking empty, and failed saves are reported.
import { start } from "./harness.mjs";
import { execFileSync } from "node:child_process";
import path from "path";
import { TOOLS } from "./paths.mjs";
const h = await start();
const { page, check, log, admin } = h;
const env = { ...process.env, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" };
execFileSync("node", ["seed.mjs", "--project", "demo-attendance"], { cwd: path.join(TOOLS, "demo-seed"), env });
const yesterday = (() => { const d = new Date(Date.now() - 86400000); if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
const barShown = () => page.evaluate(() => { const b = document.getElementById("loadErrorBar"); return !!b && !b.hidden; });
const failNext = method => page.evaluate(m => {
  const proto = m === "commit" ? firebase.firestore.WriteBatch.prototype : firebase.firestore.DocumentReference.prototype;
  const orig = proto[m];
  proto[m] = function () { proto[m] = orig; return Promise.reject(Object.assign(new Error("simulated failure"), { code: "unavailable" })); };
}, method);

log("teacher: class list without internet");
await h.login("eco.asifa", "demo1234");
await page.waitForFunction(() => document.querySelectorAll("#subjectSelect option").length > 1);
check("no warning while online", !(await barShown()));
await page.evaluate(async () => { await db.disableNetwork(); App.clearAttendanceCaches(); });
await page.selectOption("#subjectSelect", { index: 1 }); await page.fill("#attendanceDate", yesterday);
await page.waitForFunction(() => /Could not load/.test(document.getElementById("student-list").textContent), null, { timeout: 20000 });
check("class list says it could not load", true);
check("no students shown", (await page.$$("#attendanceTable tbody tr")).length === 0);
check("Save is not offered", !(await page.isVisible("#attendanceSaveBar")));
check("warning bar shown", await barShown());
h.errors.length = 0;   // the failed reads above were intended

log("teacher: internet back");
await page.evaluate(async () => { await db.enableNetwork(); App.clearAttendanceCaches(); document.getElementById("attendanceDate").dispatchEvent(new Event("change")); });
await page.waitForSelector("#attendanceTable tbody tr", { timeout: 20000 });
check("class list loads again", (await page.$$("#attendanceTable tbody tr")).length > 0);
await h.logout();

log("HOD: approving a correction when the save fails");
// (the emulator helper doesn't pass back a value, so results are collected in a variable)
const read = async fn => { let v; await admin(async db => { v = await fn(db); }); return v; };
const att = await read(async db => (await db.collection("attendance").where("departmentId", "==", "economics").limit(1).get()).docs[0].data());
const sid = Object.keys(att.records)[0];
await admin(db => db.doc("correctionRequests/777").set({ id: 777, subjectId: String(att.subjectId), date: att.date, studentId: sid,
  oldStatus: att.records[sid], requestedStatus: att.records[sid] === "Present" ? "Absent" : "Present", reason: "Offline test",
  requestedBy: String(att.markedBy), requestedAt: new Date().toISOString(), status: "pending", departmentId: "economics" }));
const state = () => read(async db => ({
  status: (await db.doc("correctionRequests/777").get()).data().status,
  corrections: (await db.collection("attendanceCorrections").where("reason", "==", "Offline test").get()).size }));
await h.login("hod.eco", "demo1234");
await page.evaluate(() => showSection("correctionsSection"));
await page.waitForSelector("#correctionsSection.active button[data-corr-action=approve]");
await failNext("commit");
await page.click("button[data-corr-action=approve]"); await h.dialog(); await h.ok();
check("HOD told it failed", /Approval failed/.test(await h.alertText()));
let s = await state();
check("nothing half-saved: request still pending, no correction", s.status === "pending" && s.corrections === 0, JSON.stringify(s));
await page.click("button[data-corr-action=approve]"); await h.dialog(); await h.ok();
check("approving again works", /Correction approved/.test(await h.alertText()));
s = await state();
check("request approved and exactly one correction", s.status === "approved" && s.corrections === 1, JSON.stringify(s));

log("HOD: adding a batch when the save fails");
await page.evaluate(() => showSection("adminSection"));
await page.waitForFunction(() => document.getElementById("teacherAssignmentList").children.length > 0);
await page.selectOption("#batchProgram", "UG");
await page.evaluate(() => document.getElementById("batchProgram").dispatchEvent(new Event("change")));
await page.fill("#batchYear", "2031");
await page.selectOption("#batchSemester", "1");
await failNext("set");
await page.click("#addBatchBtn");
check("HOD told the batch was not saved", /batch could NOT be saved/.test(await h.alertText()));
const batch2031 = await read(async db => (await db.collection("batches").where("year", "==", 2031).get()).size);
check("no batch saved", batch2031 === 0);
h.errors.splice(0, h.errors.length, ...h.errors.filter(e => !/simulated failure/.test(e)));   // intended
await h.finish();
