// Internal assessment end to end: teacher adds assessments, enters marks (with
// absent), fills attendance marks, changes a maximum (marks rescale), picks what
// counts, shares; students see only their own; HOD views only; closing the
// semester locks it, reopening unlocks; every change is logged. Also: former
// teachers go to the searchable "Former teachers" panel.
import { start } from "./harness.mjs";
import { execFileSync } from "node:child_process";
import path from "path";
import { TOOLS } from "./paths.mjs";
const h = await start();
const { page, check, log, admin } = h;
const env = { ...process.env, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" };
execFileSync("node", ["seed.mjs", "--project", "demo-attendance"], { cwd: path.join(TOOLS, "demo-seed"), env });
const read = async fn => { let v; await admin(async db => { v = await fn(db); }); return v; };
const body = () => page.textContent("#iaBody");
const settle = () => page.waitForFunction(() => !/Loading…/.test(document.getElementById("iaBody").textContent));
const open = async () => { await page.evaluate(() => showSection("assessmentSection"));
  await page.waitForFunction(() => document.querySelectorAll("#iaSubject option").length > 0); await settle(); };
// wait until the database shows a change, then until the screen has redrawn
const until = async (fn, what) => { for (let i = 0; i < 100; i++) { if (await fn()) { await page.waitForTimeout(150); await settle(); return; } await page.waitForTimeout(100); } throw new Error("timed out: " + what); };
const doc = () => read(async db => (await db.doc(`assessments/${subjectId}`).get()).data());
const prompt = async value => { await page.waitForSelector("#uiDialog.open .ui-input"); await page.fill("#uiDialog.open .ui-input", value); await h.ok(); };

log("Teacher adds assessments");
await h.login("eco.asifa", "demo1234");
await open();
const subjectId = await page.inputValue("#iaSubject");
check("starts empty", /No assessments yet/.test(await body()));
const add = async (name, kind, max, min, date) => {
  if (!(await page.$eval(".ia-add", d => d.open))) await page.click(".ia-add summary");
  await page.fill("#iaName", name); await page.selectOption("#iaKind", kind); await page.fill("#iaMax", String(max));
  await page.fill("#iaMin", String(min)); if (date) await page.fill("#iaDate", date);
  await page.click("#iaAddBtn");
  await page.waitForFunction(n => [...document.querySelectorAll(".ia-table td")].some(td => td.textContent.startsWith(n)), name);
  await settle();
};
await add("Viva", "exam", 20, 8, "2026-10-10");
await add("Attendance", "attendance", 5, 0);
check("two assessments listed", (await page.$$("[data-marks]")).length === 2);
const a0 = await read(async db => (await db.doc(`assessments/${subjectId}`).get()).data());
const viva = a0.components.find(c => c.name === "Viva"), attc = a0.components.find(c => c.name === "Attendance");

log("Viva marks: 15, absent, 5 (below minimum)");
await page.click(`[data-marks="${viva.id}"]`);
await page.waitForSelector(".ia-mark");
const sids = await page.$$eval(".ia-mark", els => els.map(e => e.dataset.sid));
const [S1, S2, S3] = sids;
await page.fill(`.ia-mark[data-sid="${S1}"]`, "15");
await page.check(`.ia-ab[data-sid="${S2}"]`);
await page.fill(`.ia-mark[data-sid="${S3}"]`, "5");
await page.click("#iaSaveMarks");
check("saved 3 changes", /Saved 3 change/.test(await h.alertText()));
await settle();
await page.click(`[data-marks="${viva.id}"]`);
await page.waitForSelector(".ia-mark");
await page.fill(`.ia-mark[data-sid="${S1}"]`, "25");
await page.click("#iaSaveMarks");
check("marks above the maximum refused", /between 0 and 20/.test(await h.alertText()));
await page.click("#iaCloseMarks");

log("Attendance marks filled from attendance");
await page.click(`[data-marks="${attc.id}"]`);
await page.waitForSelector("#iaFillAtt");
await page.click("#iaFillAtt");
check("filled from attendance", /Filled for \d+ student/.test(await h.alertText()));
const attVal = Number(await page.inputValue(`.ia-mark[data-sid="${S1}"]`));
const attText = await page.$eval(`.ia-mark[data-sid="${S1}"]`, e => e.closest("tr").children[2].textContent);
const pct = Number((attText.match(/\(([\d.]+)%\)/) || [])[1]);
check("attendance marks: 75%+ full, else in proportion", pct >= 75 ? attVal === 5 : Math.abs(attVal - Math.round(5 * pct) / 100) < 0.011, `${attText} -> ${attVal}`);
await page.click("#iaSaveMarks"); await h.alertText(); await settle();

log("Viva maximum 20 → 10: marks rescale");
await page.click(`[data-edit="${viva.id}"]`);
await prompt("Viva"); await prompt("2026-10-10"); await prompt("10"); await prompt("4");
check("asks before rescaling", /rescaled/.test(await h.dialog())); await h.ok();
await h.alertText(); await settle();
let a = await read(async db => (await db.doc(`assessments/${subjectId}`).get()).data());
check("marks rescaled 15 → 7.5, 5 → 2.5, absent stays", a.marks[viva.id][S1] === 7.5 && a.marks[viva.id][S3] === 2.5 && a.marks[viva.id][S2] === "AB", JSON.stringify(a.marks[viva.id]));

log("Award: minimum, sharing");
await page.fill("#iaFinalMin", "6"); await page.check("#iaFinalShared"); await page.click("#iaFinalSave");
check("award saved", /Saved/.test(await h.alertText())); await settle();
await page.check(`[data-shared="${viva.id}"]`);
await until(async () => (await doc()).components.find(c => c.id === viva.id).shared === true, "viva shared");
const rowOf = sid => page.$eval(`#iaAwardTable tr:nth-child(${sids.indexOf(sid) + 2})`, tr => [...tr.children].map(td => td.textContent.trim()));
const r1 = await rowOf(S1), r2 = await rowOf(S2), r3 = await rowOf(S3);
const t1 = Math.ceil(7.5 + attVal - 1e-9);
check("student 1: total rounded up, PASS", r1.at(-2) === String(t1) && r1.at(-1) === (t1 >= 6 ? "PASS" : "FAIL"), JSON.stringify(r1));
check("student 2: absent in viva shows AB", r2.includes("AB"), JSON.stringify(r2));
check("student 3: below the viva minimum but total decides", ["PASS", "FAIL"].includes(r3.at(-1)), JSON.stringify(r3));
await page.click(`[data-counted="${attc.id}"]`);                                 // discard attendance
await until(async () => (await doc()).components.find(c => c.id === attc.id).counted === false, "attendance not counted");
check("discarding a component removes it from the total", /Total = Viva = 10 marks/.test(await body()), (await body()).slice(0, 400));
await page.click(`[data-counted="${attc.id}"]`);
await until(async () => (await doc()).components.find(c => c.id === attc.id).counted === true, "attendance counted");

log("Change log and award download");
await page.click("#iaLogBtn");
await page.waitForFunction(() => /marks/.test(document.getElementById("iaLog").textContent));
const logText = await page.textContent("#iaLog");
check("log shows who, what and old → new", /Dr Asifa Bhat \(eco\.asifa\)/.test(logText) && /15 → 7\.5/.test(logText) && /max 20 → 10/.test(logText), logText.slice(0, 200));
const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#iaExcel")]);
check("award downloads as Excel", /^Award_.*\.xlsx$/.test(dl.suggestedFilename()), dl.suggestedFilename());
const logs = await read(async db => (await db.collection("assessmentLog").where("subjectId", "==", subjectId).get()).size);
check("every change written to the log", logs >= 8, String(logs));
await h.logout();

log("Students see only their own");
const loginOf = sid => read(async db => (await db.collection("users").where("studentDocId", "==", sid).get()).docs[0].data().loginId);
await h.login(await loginOf(S1), "demo1234");
await page.waitForFunction(() => /Viva/.test(document.getElementById("studentAssessmentOutput").textContent));
let mine = await page.textContent("#studentAssessmentOutput");
check("student 1 sees viva marks 7.5 / 10, attendance not shared, the award", /7\.5 \/ 10/.test(mine) && /not shared yet/.test(mine) && new RegExp(`Award: ${t1} / 15`).test(mine), mine.slice(0, 300));
const others = await page.evaluate(async sid => { try { await db.collection("assessmentViews").doc(sid).get(); return "read"; } catch (e) { return e.code; } }, `${S2}_${subjectId}`);
check("can't read a classmate's copy", others === "permission-denied", others);
await h.logout();
await h.login(await loginOf(S2), "demo1234");
await page.waitForFunction(() => /Viva/.test(document.getElementById("studentAssessmentOutput").textContent));
check("student 2 sees they were absent", /Absent/.test(await page.textContent("#studentAssessmentOutput")));
await h.logout();

log("HOD: view only");
await h.login("hod.eco", "demo1234");
await open();
await page.selectOption("#iaSubject", subjectId); await settle();
check("HOD sees the award, view only, no editing", /View only/.test(await body()) && !(await page.$("#iaAddBtn")) && !(await page.$("[data-edit]"))
  && await page.$eval(`[data-counted="${attc.id}"]`, e => e.disabled));
const hodWrite = await page.evaluate(async id => { try { await db.collection("assessments").doc(id).update({ updatedAt: "x" }); return "written"; } catch (e) { return e.code; } }, subjectId);
check("HOD can't change marks even directly", hodWrite === "permission-denied", hodWrite);

log("Former teachers panel");
await page.evaluate(() => showSection("adminSection")); await page.click("#adminTabs button[data-tab=teachers]");
await page.waitForFunction(() => document.querySelectorAll("#teacherList li").length > 0);
await page.click("#teacherList li:last-child button"); await h.dialog(); await h.ok();
await page.waitForSelector("#teacherList .former-panel");
check("deactivated teacher is in the closed 'Former teachers (1)' panel, not the list",
  /Former teachers \(1\)/.test(await page.textContent("#teacherList .former-panel summary")) && !(await page.$eval("#teacherList .former-panel", d => d.open)));
await page.click("#teacherList .former-panel summary");
check("with the date they left", /left \d{4}-\d{2}-\d{2}/.test(await page.textContent("#teacherList .former-results")));
await h.logout();

log("Closing the semester locks marks; reopening unlocks");
const subj = await read(async db => (await db.doc(`subjects/${subjectId}`).get()).data());
const batchDoc = `batches/${subj.batchId}_${subj.semester}`;
await admin(db => db.doc(batchDoc).update({ status: "CLOSED" }));
await h.login("eco.asifa", "demo1234");
await open(); await page.selectOption("#iaSubject", subjectId); await settle();
check("closed: locked note, no editing", /marks are locked/.test(await body()) && !(await page.$("#iaAddBtn")));
const lockedWrite = await page.evaluate(async id => { try { await db.collection("assessments").doc(id).update({ updatedAt: "x" }); return "written"; } catch (e) { return e.code; } }, subjectId);
check("closed: the database refuses changes", lockedWrite === "permission-denied", lockedWrite);
await admin(db => db.doc(batchDoc).update({ status: "ACTIVE" }));
await page.evaluate(() => App.IA.render()); await settle();
check("reopened: editable again", !!(await page.$("#iaAddBtn")));
await h.finish();
