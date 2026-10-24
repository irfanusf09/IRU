// Students set up their own login: HOD uploads dates of birth; students activate
// with roll number + date of birth (choosing a password and PIN); forgot
// password with roll number + date of birth + PIN; HOD slips and resets still work
// and lead to choosing a PIN; the HOD sees who has activated.
import { start } from "./harness.mjs";
import { execFileSync } from "node:child_process";
import fs from "fs"; import path from "path";
import * as XLSX from "@e965/xlsx";
import { TOOLS, TMP } from "./paths.mjs";
XLSX.set_fs(fs);
const h = await start();
const { page, check, log, admin } = h;
execFileSync("node", ["seed.mjs", "--project", "demo-attendance"], { cwd: path.join(TOOLS, "demo-seed"),
  env: { ...process.env, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" } });
const read = async fn => { let v; await admin(async db => { v = await fn(db); }); return v; };
const book = (rows, file) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Sheet1"); XLSX.writeFile(wb, file); return file; };
const expected = () => h.errors.splice(0, h.errors.length, ...h.errors.filter(e => !/refused|PERMISSION_DENIED|status of 400|Sign-in failed/.test(e)));
const loginScreen = async () => { await page.goto("http://localhost:5555/"); await page.waitForSelector("#loginScreen", { state: "visible" }); };
const activate = async (roll, dob, pw, pin) => {
  await loginScreen(); await page.click("#activateLink");
  await page.fill("#actRoll", roll); await page.fill("#actDob", dob); await page.fill("#actPw", pw); await page.fill("#actPw2", pw); await page.fill("#actPin", pin);
  await page.click("#actBtn");
  await page.waitForFunction(() => !/Please wait/.test(document.getElementById("actMsg").textContent) && document.getElementById("actMsg").textContent, null, { timeout: 20000 });
  return page.textContent("#actMsg");
};
const resetPw = async (roll, dob, pin, pw) => {
  await loginScreen(); await page.click("#forgotLink");
  await page.fill("#resRoll", roll); await page.fill("#resDob", dob); await page.fill("#resPin", pin); await page.fill("#resPw", pw); await page.fill("#resPw2", pw);
  await page.click("#stuResetBtn");
  await page.waitForFunction(() => !/Please wait/.test(document.getElementById("resMsg").textContent) && document.getElementById("resMsg").textContent, null, { timeout: 20000 });
  return page.textContent("#resMsg");
};
const inApp = () => page.waitForSelector("#appContainer", { state: "visible", timeout: 15000 }).then(() => true, () => false);

log("HOD uploads students with dates of birth");
await h.login("hod.eco", "demo1234");
await page.evaluate(() => showSection("adminSection"));
await page.click("#adminTabs button[data-tab=students]");
await page.waitForFunction(() => document.querySelectorAll("#studentUploadSubjectSelect option[value]").length && document.getElementById("studentUploadSubjectSelect").value);
const subjectId = await page.inputValue("#studentUploadSubjectSelect");
await page.setInputFiles("#excelFile", book([
  { Name: "Self One", Roll: 29001, "Date of birth": "14-03-2005" },
  { Name: "Slip Two", Roll: 29002, "Date of birth": new Date(Date.UTC(2004, 10, 2)) },     // a real Excel date cell
  { Name: "Bad Date", Roll: 29003, "Date of birth": "31-02-2005" },
  { Name: "No Date", Roll: 29004 }], `${TMP}/dob.xlsx`));
await page.click("#uploadExcelBtn");
await page.waitForFunction(() => /successful|FAILED/.test(document.getElementById("uploadStatus").textContent), null, { timeout: 20000 });
const up = await page.textContent("#uploadStatus");
check("upload reports 2 dates of birth saved and the bad one", /2 date\(s\) of birth saved/.test(up) && /not understood for: 29003/.test(up), up);
const stored = await read(async db => ({ act: (await db.doc("activation/29001").get()).data(), secret: (await db.doc("studentSecrets/29001").get()).data() }));
check("only a hash is stored, not the date", stored.act.activated === false && /^[0-9A-F]{64}$/.test(stored.secret.dobHash) && !JSON.stringify(stored).includes("2005"), JSON.stringify(stored).slice(0, 200));
const subj = await read(async db => (await db.doc(`subjects/${subjectId}`).get()).data());
await page.click("#adminTabs button[data-tab=logins]");
await page.waitForSelector("#studentLoginBatchSelect option", { state: "attached" });
await page.selectOption("#studentLoginBatchSelect", String(subj.batchId));
await page.click("#loadStudentLoginsBtn");
await page.waitForFunction(() => /29001/.test(document.getElementById("studentLoginsOutput").textContent));
const statusOf = roll => page.$$eval("#studentLoginsOutput tr", (trs, r) => (trs.find(tr => tr.children[0] && tr.children[0].textContent.trim() === r) || { textContent: "" }).textContent.replace(/\s+/g, " "), roll);
check("HOD sees who can activate", /Can activate/.test(await statusOf("29001")) && /no date of birth on record/.test(await statusOf("29004")), await statusOf("29004"));
await h.logout();

log("Student activates with roll number + date of birth");
let msg = await activate("29001", "15-03-2005", "mypass1", "4821");
check("wrong date of birth refused", /don't match/.test(msg), msg);
check("bad PIN refused", /exactly 4 digits/.test(await activate("29001", "14-03-2005", "mypass1", "48")));
msg = await activate("29001", "14-03-2005", "mypass1", "4821");
check("right date of birth: activated and logged in", /Activated/.test(msg) && await inApp(), msg);
await page.waitForSelector("#studentDashboardSection.active");
check("student sees their dashboard, not asked for a PIN again", !(await page.isVisible("#uiDialog.open")));
await h.logout();
check("can't activate twice", /already activated/.test(await activate("29001", "14-03-2005", "other12", "1111")));
expected();

log("Forgot password: roll number + date of birth + PIN");
msg = await resetPw("29001", "14-03-2005", "1111", "newpass2");
check("wrong PIN refused", /doesn't match/.test(msg), msg);
msg = await resetPw("29001", "14-03-2005", "4821", "newpass2");
check("right PIN: new password, logged in", /Password changed/.test(msg) && await inApp(), msg);
await h.logout();
await loginScreen();
await page.fill("#loginUsername", "29001"); await page.fill("#loginPassword", "mypass1"); await page.click("#loginBtn");
await page.waitForFunction(() => document.getElementById("loginError").textContent.length > 0);
check("old password no longer works", /incorrect/i.test(await page.textContent("#loginError")));
await h.login("29001", "newpass2");
check("new password works", await page.isVisible("#studentDashboardSection.active"));
await h.logout();
expected();

log("HOD slips still work; those students choose a PIN at first login");
await h.login("hod.eco", "demo1234");
await page.evaluate(() => showSection("adminSection"));
await page.click("#adminTabs button[data-tab=logins]");
await page.waitForSelector("#studentLoginBatchSelect option", { state: "attached" });
await page.selectOption("#studentLoginBatchSelect", String(subj.batchId));
await page.click("#createStudentLoginsBtn"); await h.dialog(); await h.ok();
await page.waitForSelector("#downloadSlipsBtn", { timeout: 30000 });
const slip = await page.$$eval("#studentLoginsOutput table tr", trs => Object.fromEntries(trs.slice(1).map(tr => [tr.children[0].textContent.trim(), tr.children[3].textContent.trim()])));
check("slips made for the students without a login", !!slip["29002"] && !!slip["29004"], JSON.stringify(slip));
await page.click("#doneSlipsBtn"); await h.dialog(); await h.ok();
await h.logout();
check("a student with a slip can't also activate", /already activated/.test(await activate("29002", "02-11-2004", "xpass12", "1234")));
expected();
await h.loginFirst("29002", slip["29002"], "slipnew1");
await page.waitForSelector("#uiDialog.open .ui-input");
check("asked to choose a PIN", /Choose a 4-digit PIN/.test(await page.textContent("#uiDialog .ui-msg")));
await page.fill("#uiDialog.open .ui-input", "2468"); await h.ok();
check("PIN saved", /PIN saved/.test(await h.alertText()));
await h.logout();
check("…and that PIN works for a reset (date from the Excel date cell)", /Password changed/.test(await resetPw("29002", "02-11-2004", "2468", "slipnew2")) && await inApp());
await h.logout();
await h.loginFirst("29004", slip["29004"], "nodob12");
await page.waitForTimeout(1500);
check("no date of birth on record: not asked for a PIN", !(await page.isVisible("#uiDialog.open")));
await h.logout();

log("HOD reset clears the PIN; HOD sees statuses");
await h.login("hod.eco", "demo1234");
await page.evaluate(() => showSection("adminSection"));
await page.click("#adminTabs button[data-tab=logins]");
await page.waitForSelector("#studentLoginBatchSelect option", { state: "attached" });
await page.selectOption("#studentLoginBatchSelect", String(subj.batchId));
await page.click("#loadStudentLoginsBtn");
await page.waitForFunction(() => /29001/.test(document.getElementById("studentLoginsOutput").textContent));
check("29001: activated by the student, PIN set", /Activated by the student/.test(await statusOf("29001")) && /Set/.test(await statusOf("29001")), await statusOf("29001"));
check("29004: has login, no PIN possible", /Has login/.test(await statusOf("29004")) && /—/.test(await statusOf("29004")), await statusOf("29004"));
const st1 = await read(async db => (await db.collection("students").where("roll", "==", "29001").get()).docs[0].id);
await page.click(`#studentLoginsOutput button[data-reset="${st1}"]`); await h.dialog(); await h.ok();
await page.waitForSelector("#downloadSlipsBtn", { timeout: 20000 });
const after = await read(async db => ({ act: (await db.doc("activation/29001").get()).data(), secret: (await db.doc("studentSecrets/29001").get()).data() }));
check("HOD reset clears the PIN", after.act.hasPin === false && after.secret.pinHash === null, JSON.stringify(after).slice(0, 200));
await h.finish();
