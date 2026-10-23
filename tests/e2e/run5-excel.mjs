// Excel features with SheetJS 0.20.3: teacher upload, student upload, report export, backup, login slips.
import { start, SHOTS } from "./harness.mjs";
import { tagAll } from "./tagall.mjs";
import * as XLSX from "@e965/xlsx";
import fs from "fs";
import { TMP } from "./paths.mjs";
XLSX.set_fs(fs);
const h = await start();
const { page, admin, check, log } = h;
const SUBJ = "1700000000001";
const tmp = TMP;
fs.mkdirSync(tmp, { recursive: true });
const book = (rows, file) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Sheet1"); XLSX.writeFile(wb, file); return file; };
const readDownload = async dl => { const p = `${tmp}/${dl.suggestedFilename()}`; await dl.saveAs(p); return XLSX.readFile(p); };

const hod = await h.signUp("hod@users.attendance.example.com");
await admin(async db => {
  const set = (p, d) => db.doc(p).set(d);
  await set("config/hod", { uid: hod });
  await set(`users/${hod}`, { role: "HOD", name: "Head", loginId: "hod", active: true, mustChangePassword: false });
  await set("loginNames/hod", { email: "hod@users.attendance.example.com", uid: hod });
  await set("batches/1700000000000_3", { id: 1700000000000, program: "UG", year: 2025, semester: "3", status: "ACTIVE" });
  await set(`subjects/${SUBJ}`, { id: Number(SUBJ), name: "Microeconomics", batchId: 1700000000000, type: "MAJOR", program: "UG", semester: "3", year: 2025 });
});

await tagAll(admin);
await h.login("hod");
await page.evaluate(() => showSection("adminSection"));

log("Teacher upload from Excel");
await page.click("#adminTabs button[data-tab=teachers]");
await page.setInputFiles("#teacherExcelFile", book([{ Name: "Asha Bhat", Username: "asha", Password: "start123" }], `${tmp}/teachers.xlsx`));
await page.click("#uploadTeacherExcelBtn");
await page.waitForFunction(() => /Added/.test(document.getElementById("teacherUploadStatus").textContent), null, { timeout: 20000 });
check("teacher added with login", /Added 1 teacher/.test(await page.textContent("#teacherUploadStatus")), await page.textContent("#teacherUploadStatus"));
let login = null; await admin(async db => { login = (await db.doc("loginNames/asha").get()).data(); });
check("teacher login ID created", !!(login && login.uid));

log("Student upload from Excel");
await page.click("#adminTabs button[data-tab=students]");
await page.waitForSelector(`#studentUploadSubjectSelect option[value="${SUBJ}"]`, { state: "attached" });
await page.selectOption("#studentUploadSubjectSelect", SUBJ);
await page.setInputFiles("#excelFile", book([{ Name: "Student One", Roll: 1 }, { Name: "Student Two", Roll: 2 }, { Name: "Student Three", Roll: 3 }], `${tmp}/students.xlsx`));
await page.click("#uploadExcelBtn");
await page.waitForFunction(() => /successful|FAILED/.test(document.getElementById("uploadStatus").textContent), null, { timeout: 20000 });
check("3 students uploaded", /3 new student/.test(await page.textContent("#uploadStatus")), await page.textContent("#uploadStatus"));
let enrolled = []; await admin(async db => { enrolled = (await db.doc(`enrollments/${SUBJ}`).get()).data().students; });
check("3 students enrolled in the subject", enrolled.length === 3);

log("Student login slips download");
await page.click("#adminTabs button[data-tab=logins]");
await page.waitForSelector("#studentLoginBatchSelect option", { state: "attached" });
await page.click("#createStudentLoginsBtn"); await h.dialog(); await h.ok();
await page.waitForSelector("#downloadSlipsBtn", { timeout: 30000 });
let [dl] = await Promise.all([page.waitForEvent("download"), page.click("#downloadSlipsBtn")]);
let wb = await readDownload(dl);
const slips = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
check("login slips file has 3 rows with passwords", slips.length === 3 && slips.every(r => r.Password && r["Login ID"]), JSON.stringify(slips[0]));
await page.click("#doneSlipsBtn"); await h.dialog(); await h.ok();

log("Report export to Excel");
const stu = []; await admin(async db => { (await db.collection("students").get()).forEach(d => stu.push(d.data())); });
await admin(async db => db.doc(`attendance/${SUBJ}_2026-10-19`).set({ subjectId: SUBJ, date: "2026-10-19",
  records: Object.fromEntries(stu.map((s, i) => [String(s.id), i ? "Present" : "Absent"])), markedBy: "", departmentId: "ECO" }));
await page.evaluate(() => showSection("reportsSection"));
await page.waitForSelector(`#subjectFilter option[value="${SUBJ}"]`, { state: "attached" });
await page.fill("#fromDate", "2026-10-01"); await page.fill("#toDate", "2026-10-22");
await page.click("#generateBtn"); await page.waitForSelector("#reportOutput table");
[dl] = await Promise.all([page.waitForEvent("download"), page.click("#exportExcelBtn")]);
wb = await readDownload(dl);
const rep = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
check("report export has the 3 students", rep.filter(r => /Student (One|Two|Three)/.test(String(r[0]))).length === 3, JSON.stringify(rep.slice(0, 3)));

log("Backup (Excel)");
await page.evaluate(() => showSection("hodDashboardSection"));
[dl] = await Promise.all([page.waitForEvent("download"), page.click("#backupExcelBtn")]);
wb = await readDownload(dl);
const studentsSheet = XLSX.utils.sheet_to_json(wb.Sheets["Students"]);
check("backup has all sheets", ["Batches", "Subjects", "Teachers", "Students", "Attendance", "Leaves"].every(n => wb.SheetNames.includes(n)), wb.SheetNames.join(","));
check("backup Students sheet has 3 students", studentsSheet.length === 3);
check("backup Attendance sheet has 3 rows", XLSX.utils.sheet_to_json(wb.Sheets["Attendance"]).length === 3);
check("page loaded SheetJS 0.20.3", (await page.evaluate(() => XLSX.version)) === "0.20.3", await page.evaluate(() => XLSX.version));
await h.finish();
