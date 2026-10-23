// Multi-department flow from an empty install.
import { start, SHOTS } from "./harness.mjs";
import * as XLSX from "@e965/xlsx";
import fs from "fs";
import { TMP } from "./paths.mjs";
XLSX.set_fs(fs);
const h = await start();
const { page, admin, check, log } = h;
const tmp = TMP;
fs.mkdirSync(tmp, { recursive: true });
const book = (rows, file) => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Sheet1"); XLSX.writeFile(wb, file); return file; };
const pw = text => (text.match(/(?:Starting password|Password): (\S+)/) || [])[1];
const docs = async (c, f = () => true) => { const out = []; await admin(async db => (await db.collection(c).get()).forEach(d => { if (f(d.data())) out.push({ id: d.id, ...d.data() }); })); return out; };
const goTab = async (sectionId, tab) => { await page.evaluate(id => showSection(id), sectionId); await page.click(`#${sectionId === "adminSection" ? "adminTabs" : "instTabs"} button[data-tab=${tab}]`); };

// ---------- 1. First-time setup ----------
log("First-time setup creates the Institution Admin");
await page.goto("http://localhost:5555/");
await page.waitForSelector("#setupLink", { state: "visible" });
check("login page offers 'First-time setup (Institution Admin)'", /Institution Admin/.test(await page.textContent("#setupLink")));
await page.click("#setupLink");
await page.fill("#setupInstitution", "Test College");
await page.fill("#setupName", "Office Admin");
await page.fill("#setupPassword", "adminpass1"); await page.fill("#setupPassword2", "adminpass1");
await page.click("#setupBtn");
await h.alertText();
await page.waitForSelector("#institutionSection.active");
check("Admin lands on Institution Setup", true);

// ---------- 2. Departments, HODs, Principal ----------
log("Admin adds departments and logins");
await page.click("#instTabs button[data-tab=departments]");
await page.fill("#deptNameInput", "Economics"); await page.click("#addDeptBtn"); await h.alertText();
await page.fill("#deptNameInput", "Physics"); await page.check("#deptPG"); await page.click("#addDeptBtn"); await h.alertText();
const depts = await docs("departments");
check("two departments", depts.length === 2 && depts.find(d => d.name === "Physics").programs.join() === "UG,PG", JSON.stringify(depts));
const ECO = depts.find(d => d.name === "Economics").id, PHY = depts.find(d => d.name === "Physics").id;
const leader = async (role, dept, name, loginId) => {
  await page.click("#instTabs button[data-tab=accounts]");
  await page.selectOption("#leaderRole", role);
  if (dept) await page.selectOption("#leaderDept", dept);
  await page.fill("#leaderName", name); await page.fill("#leaderLoginId", loginId);
  await page.click("#addLeaderBtn");
  return pw(await h.alertText());
};
const pwHodEco = await leader("HOD", ECO, "Dr Eco", "hod.eco");
const pwHodPhy = await leader("HOD", PHY, "Dr Phy", "hod.phy");
const pwPrin = await leader("Principal", null, "The Principal", "principal");
check("three logins created", !!(pwHodEco && pwHodPhy && pwPrin));
await page.waitForFunction(() => /Dr Phy/.test(document.getElementById("leaderList").textContent));
await page.screenshot({ path: `${SHOTS}/inst-accounts.png`, fullPage: true });
await page.click("#instTabs button[data-tab=departments]");
await page.waitForFunction(() => /Dr Eco/.test(document.getElementById("deptList").textContent));
await page.screenshot({ path: `${SHOTS}/inst-departments.png`, fullPage: true });
// Institution-wide closed day
await page.click("#instTabs button[data-tab=closures]");
await page.fill("#instClosedDate", "2026-10-21"); await page.fill("#instClosedReason", "Snowfall"); await page.click("#instClosedBtn");
await page.waitForFunction(() => /Snowfall/.test(document.getElementById("instClosedList").textContent));
check("institution closed day saved as 2026-10-21 / ALL", (await docs("dayStatuses")).some(d => d.id === "2026-10-21" && d.departmentId === "ALL"));
await h.logout();

// ---------- 3. Each HOD sets up their department ----------
async function setupDept(loginId, password, { teacher, teacherLogin, subject, type, rows, closeDay }) {
  await h.loginFirst(loginId, password);
  await page.waitForSelector("#hodDashboardSection.active");
  await goTab("adminSection", "batches");
  await page.waitForTimeout(500);
  const progs = await page.$$eval("#batchProgram option", os => os.filter(o => !o.hidden).map(o => o.value));
  await page.selectOption("#batchProgram", "UG");
  await page.fill("#batchYear", "2025"); await page.selectOption("#batchSemester", "3"); await page.click("#addBatchBtn");
  await page.waitForFunction(() => /UG Sem 3 \(Batch 2025\)/.test(document.getElementById("batchList").textContent));
  await page.waitForSelector("#subjectBatchSelect option", { state: "attached" });
  await page.fill("#subjectNameInput", subject); await page.selectOption("#subjectTypeSelect", type); await page.click("#addSubjectBtn");
  await page.waitForFunction(s => document.getElementById("subjectList").textContent.includes(s), subject);
  await goTab("adminSection", "teachers");
  await page.fill("#teacherNameInput", teacher); await page.fill("#teacherUsernameInput", teacherLogin); await page.fill("#teacherPasswordInput", "start123");
  await page.click("#addTeacherBtn"); await h.alertText();
  await page.waitForFunction(t => [...document.querySelectorAll("#assignTeacherSelect option")].some(o => o.textContent === t), teacher);
  await page.selectOption("#assignTeacherSelect", { label: teacher });
  await page.click("#assignSubjectBtn");
  await page.waitForFunction(s => document.getElementById("teacherAssignmentList").textContent.includes(s), subject);
  await goTab("adminSection", "students");
  await page.waitForFunction(() => document.querySelectorAll("#studentUploadSubjectSelect option[value]").length && document.getElementById("studentUploadSubjectSelect").value);
  await page.setInputFiles("#excelFile", book(rows, `${tmp}/${loginId}.xlsx`));
  await page.click("#uploadExcelBtn");
  await page.waitForFunction(() => /successful|FAILED/.test(document.getElementById("uploadStatus").textContent), null, { timeout: 20000 });
  const upload = await page.textContent("#uploadStatus");
  if (closeDay) {
    await goTab("adminSection", "closures");
    await page.fill("#closedDayDate", closeDay); await page.fill("#closedDayReason", "Department fest"); await page.click("#addClosedDayBtn");
    await page.waitForFunction(() => /Department fest/.test(document.getElementById("closedDayList").textContent));
  }
  return { progs, upload };
}
log("Economics HOD");
const eco = await setupDept("hod.eco", pwHodEco, { teacher: "Asha Bhat", teacherLogin: "asha", subject: "Microeconomics", type: "MAJOR",
  rows: [{ Name: "Aamir", Roll: 1001 }, { Name: "Bisma", Roll: 1002 }, { Name: "Chand", Roll: 1003 }] });
check("Economics offers only UG batches", eco.progs.join() === "UG", eco.progs.join());
check("Economics upload: 3 new students", /3 new student/.test(eco.upload), eco.upload);
// Student logins: roll numbers
await goTab("adminSection", "logins");
await page.waitForSelector("#studentLoginBatchSelect option", { state: "attached" });
await page.click("#createStudentLoginsBtn"); await h.dialog(); await h.ok();
await page.waitForSelector("#downloadSlipsBtn");
const slipRows = await page.$$eval("#studentLoginsOutput table tr", trs => trs.slice(1).map(tr => [...tr.cells].map(c => c.textContent.trim())));
check("student login IDs are roll numbers", slipRows.map(r => r[2]).join() === "1001,1002,1003", JSON.stringify(slipRows));
const pwStudent = slipRows[0][3];
await page.click("#doneSlipsBtn"); await h.ok();
await h.logout();

log("Physics HOD (Minor for Economics students)");
const phy = await setupDept("hod.phy", pwHodPhy, { teacher: "Ravi Kaul", teacherLogin: "ravi", subject: "Physics for Economists", type: "MINOR",
  rows: [{ Name: "Aamir", Roll: 1001 }, { Name: "Bisma", Roll: 1002 }, { Name: "Nobody", Roll: 9999 }], closeDay: "2026-10-20" });
check("Physics offers UG and PG", phy.progs.join() === "UG,PG", phy.progs.join());
check("Minor upload enrolls 2 Economics students, reports 9999", /0 new student/.test(phy.upload) && /2 from other departments/.test(phy.upload) && /9999/.test(phy.upload), phy.upload);
check("no duplicate students created", (await docs("students")).length === 3);
// Student manager shows them as Economics students, without delete/exit
await goTab("adminSection", "students");
await page.waitForFunction(() => document.querySelectorAll("#studentManagerBatchSelect option").length > 1);
await page.waitForTimeout(2500);   // the Admin Panel reloads its lists when opened
await page.selectOption("#studentManagerBatchSelect", { index: 1 });
await page.dispatchEvent("#studentManagerBatchSelect", "change");
try { await page.waitForFunction(() => document.querySelectorAll("#studentManagerSubjectSelect option").length > 1, null, { timeout: 8000 }); }
catch (e) { console.log("DEBUG batch options:", await page.$$eval("#studentManagerBatchSelect option", os => os.map(o => o.value + "=" + o.textContent)), "value:", await page.inputValue("#studentManagerBatchSelect"), "\nerrors:", h.errors.join("\n")); throw e; }
await page.selectOption("#studentManagerSubjectSelect", { index: 1 });
await page.click("#loadStudentManagerBtn");
await page.waitForFunction(() => /Aamir/.test(document.getElementById("studentManagerOutput").textContent));
const mgr = await page.textContent("#studentManagerOutput");
check("Minor list shows '(Economics student)', no Delete/Exit buttons", /Economics student/.test(mgr) && !(await page.$("#studentManagerOutput button")), mgr.replace(/\s+/g, " ").slice(0, 160));
await h.logout();

// ---------- 4. Teachers mark ----------
async function mark(login, absentRoll) {
  await h.loginFirst(login, "start123");
  await page.waitForSelector("#attendanceSection.active");
  await page.waitForFunction(() => document.querySelectorAll("#subjectSelect option").length > 1);
  const subjects = await page.$$eval("#subjectSelect option", os => os.slice(1).map(o => o.textContent));
  await page.selectOption("#subjectSelect", { index: 1 });
  await page.fill("#attendanceDate", "2026-10-19");
  await page.waitForSelector("#attendanceTable tbody tr");
  await page.click(`#attendanceTable tbody tr:has(td:nth-child(2):text-is("${absentRoll}")) td:nth-child(3)`);
  await page.click("#saveBtn");
  const msg = await h.alertText();
  // institution and department closed days
  await page.fill("#attendanceDate", "2026-10-21");
  await page.waitForFunction(() => /Day is closed/.test(document.getElementById("student-list").textContent));
  await page.fill("#attendanceDate", "2026-10-20");
  await page.waitForFunction(() => document.getElementById("attendanceTable") || /Day is closed/.test(document.getElementById("student-list").textContent));
  const closed20 = /Day is closed/.test(await page.textContent("#student-list"));
  await h.logout();
  return { subjects, msg, closed20 };
}
log("Teachers mark attendance");
const asha = await mark("asha", "1002");
check("Asha sees only Microeconomics", asha.subjects.length === 1 && /Microeconomics/.test(asha.subjects[0]), asha.subjects.join("|"));
check("Asha's save succeeds", /saved successfully/.test(asha.msg) && /Present: 2 \| Absent: 1/.test(asha.msg) && !/⚠️/.test(asha.msg), asha.msg);
check("Economics is open on Physics' closed day", !asha.closed20);
const ravi = await mark("ravi", "1001");
check("Ravi sees only his Minor", ravi.subjects.length === 1 && /Physics for Economists/.test(ravi.subjects[0]), ravi.subjects.join("|"));
check("Ravi's save succeeds", /saved successfully/.test(ravi.msg) && /Present: 1 \| Absent: 1/.test(ravi.msg) && !/⚠️/.test(ravi.msg), ravi.msg);
check("Physics' own closed day is closed for Ravi", ravi.closed20);
const sums = await docs("classSummaries");
check("two class summaries with teacher names", sums.length === 2 && sums.every(s => s.teacherName && s.departmentId), JSON.stringify(sums.map(s => [s.departmentId, s.teacherName, s.present, s.absent])));

// ---------- 5. Student sees both subjects ----------
log("Economics student logs in with roll number");
await h.loginFirst("1001", pwStudent);
await page.waitForFunction(() => /Physics for Economists/.test(document.getElementById("studentDashboardOutput").textContent) &&
                                 /Microeconomics/.test(document.getElementById("studentDashboardOutput").textContent), null, { timeout: 15000 });
const dash = (await page.textContent("#studentDashboardOutput")).replace(/\s+/g, " ");
check("dashboard: Microeconomics 1/1, Physics Minor 0/1", /Microeconomics \[MAJOR\] 1 \/ 1/.test(dash) && /Physics for Economists \[MINOR\] 0 \/ 1/.test(dash), dash.slice(0, 300));
await page.screenshot({ path: `${SHOTS}/student-two-depts.png`, fullPage: true });
await h.logout();

// ---------- 6. HOD views stay within their department ----------
log("HOD reports stay within the department");
await h.login("hod.eco");
await page.evaluate(() => showSection("reportsSection"));
await page.waitForFunction(() => document.querySelectorAll("#subjectFilter option").length > 1);
const ecoSubjects = await page.$$eval("#subjectFilter option", os => os.map(o => o.textContent));
check("Economics HOD's reports list only Economics subjects", ecoSubjects.length === 2 && !ecoSubjects.some(t => /Physics/.test(t)), ecoSubjects.join("|"));
// Printed notice carries institution and department names
await page.evaluate(() => { window.open = () => ({ document: { write(h) { window.__notice = h; }, close() {} }, focus() {}, print() {}, close() {} }); });
await page.evaluate(() => showSection("defaultersSection"));
await page.waitForFunction(() => document.querySelectorAll("#defaulterBatchSelect option").length > 1);
await page.selectOption("#defaulterBatchSelect", { index: 1 });
await page.click("#generateDefaultersBtn");
await page.waitForSelector("#defaultersOutput table");
await page.click("#printDefaultersNoticeBtn");
await page.waitForFunction(() => window.__notice, null, { timeout: 5000 }).catch(() => {});
const notice = await page.evaluate(() => window.__notice || "");
check("notice says TEST COLLEGE / DEPARTMENT OF ECONOMICS", /TEST COLLEGE/.test(notice) && /DEPARTMENT OF ECONOMICS/.test(notice) && !/AMAR SINGH/.test(notice));
await h.logout();
await h.login("hod.phy");
await page.evaluate(() => showSection("reportsSection"));
await page.waitForFunction(() => document.querySelectorAll("#subjectFilter option").length > 1);
await page.fill("#fromDate", "2026-10-01"); await page.fill("#toDate", "2026-10-22");
await page.click("#generateBtn"); await page.waitForSelector("#reportOutput table");
const phyRep = (await page.textContent("#reportOutput")).replace(/\s+/g, " ");
check("Physics HOD's report shows the Economics students in the Minor", /1001 - Aamir/.test(phyRep) && /1002 - Bisma/.test(phyRep), phyRep.slice(0, 200));
await h.logout();

// ---------- 7. Principal ----------
log("Principal's dashboard");
await h.loginFirst("principal", pwPrin);
await page.waitForSelector("#principalSection.active");
const menu = await page.$$eval("#sidebar button[onclick]", bs => bs.filter(b => b.offsetParent).map(b => b.textContent.trim()));
check("Principal's menu: only the Institution Dashboard", menu.join("|") === "🏛️ Institution Dashboard", menu.join("|"));
await page.fill("#principalDate", "2026-10-19"); await page.dispatchEvent("#principalDate", "change");
await page.waitForSelector("#principalOutput table");
await page.waitForTimeout(1500);   // let any older (today's) load finish too
const pd = (await page.textContent("#principalOutput")).replace(/\s+/g, " ");
check("2 classes held, 3 present, 2 absent", /2 ?classes held 3 ?present 2 ?absent 0 ?on leave 60% ?attendance/.test(pd), pd.slice(0, 200));
check("per department rows", /Economics ?1 ?0 ?2 ?1 ?0 ?67%/.test(pd) && /Physics ?1 ?0 ?1 ?1 ?0 ?50%/.test(pd), pd.slice(150, 420));
await page.click("details.dept-classes summary");
check("who taught: Asha Bhat and Ravi Kaul", /Asha Bhat/.test(await page.textContent("#principalOutput")) && /Ravi Kaul/.test(await page.textContent("#principalOutput")));
await page.click("#principalNotMarkedBtn");
await page.waitForFunction(() => document.getElementById("principalNotMarked").textContent.trim().length > 12);
check("no class left unmarked", /Every active class is marked/.test(await page.textContent("#principalNotMarked")), await page.textContent("#principalNotMarked"));
await page.screenshot({ path: `${SHOTS}/principal-dashboard.png`, fullPage: true });
await page.fill("#principalDate", "2026-10-21"); await page.dispatchEvent("#principalDate", "change");
await page.waitForFunction(() => /Snowfall/.test(document.getElementById("principalOutput").textContent));
check("closed institution day shown", true);
await h.logout();
await h.finish();
