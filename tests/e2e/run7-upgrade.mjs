// Upgrading an old single-department install (data as saved by v1.4).
import { start, SHOTS } from "./harness.mjs";
const h = await start();
const { page, admin, check, log } = h;
const SUBJ = "1700000000001";
const STU = [1700000000100.25, 1700000000101.5];
const pw = text => (text.match(/(?:Starting password|Password): (\S+)/) || [])[1];

// ---------- an old install ----------
const uids = {};
for (const who of ["hod", "t1", "s1"]) uids[who] = await h.signUp(`${who}@users.attendance.example.com`);
await admin(async db => {
  const set = (p, d) => db.doc(p).set(d);
  await set("config/hod", { uid: uids.hod });
  await set(`users/${uids.hod}`, { role: "HOD", name: "Old HOD", loginId: "hod", active: true, mustChangePassword: false });
  await set(`users/${uids.t1}`, { role: "Teacher", name: "Asha Bhat", loginId: "t1", teacherId: "T1", active: true, mustChangePassword: false });
  await set(`users/${uids.s1}`, { role: "Student", name: "Student One", loginId: "ug2025-1", studentId: STU[0], studentDocId: String(STU[0]), roll: "1", active: true, mustChangePassword: false });
  await set("loginNames/hod", { email: "hod@users.attendance.example.com", uid: uids.hod });
  await set("loginNames/t1", { email: "t1@users.attendance.example.com", uid: uids.t1 });
  await set("loginNames/ug2025-1", { email: "s1@users.attendance.example.com", uid: uids.s1 });
  await set("teachers/T1", { id: "T1", name: "Asha Bhat", username: "t1", loginId: "t1", uid: uids.t1, status: "ACTIVE" });
  await set("batches/1700000000000_3", { id: 1700000000000, program: "UG", year: 2025, semester: "3", status: "ACTIVE" });
  await set(`subjects/${SUBJ}`, { id: Number(SUBJ), name: "Microeconomics", batchId: 1700000000000, type: "MAJOR", program: "UG", semester: "3", year: 2025 });
  await set(`subjectAssignments/${SUBJ}`, { subjectId: SUBJ, teacherId: "T1", history: [] });
  await set(`enrollments/${SUBJ}`, { subjectId: SUBJ, students: STU });
  await set(`students/${STU[0]}`, { id: STU[0], name: "Student One", roll: "1", batchId: 1700000000000, status: "ACTIVE", uid: uids.s1, loginId: "ug2025-1" });
  await set(`students/${STU[1]}`, { id: STU[1], name: "Student Two", roll: "2", batchId: 1700000000000, status: "ACTIVE" });
  await set(`attendance/${SUBJ}_2026-10-13`, { subjectId: SUBJ, date: "2026-10-13", records: { [String(STU[0])]: "Present", [String(STU[1])]: "Absent" }, markedBy: "T1" });
  await set(`attendance/${SUBJ}_2026-10-14`, { subjectId: SUBJ, date: "2026-10-14", records: { [String(STU[0])]: "Absent", [String(STU[1])]: "Present" }, markedBy: "T1" });
  await set(`leaves/${SUBJ}_2026-10-14_${STU[0]}`, { subjectId: SUBJ, date: "2026-10-14", studentId: String(STU[0]), type: "MEDICAL", reference: "", markedBy: "T1", markedAt: "x" });
  await set("dayStatuses/2026-10-16", { date: "2026-10-16", type: "weather", reason: "Old snow day" });
});

log("Old HOD sees only 'Set up departments'");
await h.login("hod");
await page.waitForSelector("#upgradeSection.active");
const menu = await page.$$eval("#sidebar button[onclick]", bs => bs.filter(b => b.offsetParent).map(b => b.textContent.trim()));
check("menu: only 'Set up departments'", menu.join("|") === "⬆️ Set up departments", menu.join("|"));
await page.waitForSelector("#upBtn");
await page.fill("#upInstitution", "Test College"); await page.fill("#upName", "Office Admin");
await page.click("#upBtn");
await page.waitForFunction(() => /Institution Admin login created/.test(document.getElementById("upgradeOutput").textContent));
const bolds = await page.$$eval("#upgradeOutput p b", bs => bs.map(b => b.textContent.trim()));
const adminPw = bolds[2];   // "✅ …", login ID, password
check("shown login ID is 'admin'", bolds[1] === "admin", bolds.join("|"));
check("Admin login created (shown once)", !!adminPw, adminPw);
await page.screenshot({ path: `${SHOTS}/upgrade-hod.png`, fullPage: true });
await h.logout();

log("Admin moves the old records");
await h.loginFirst("admin", adminPw);
await page.waitForSelector("#institutionSection.active");
await page.waitForSelector("#instUpgradeTab", { state: "visible" });
check("'Old records' tab shown and opened", await page.isVisible("#upgradeOldRecords") && /First add that department/.test(await page.textContent("#upgradeOldRecords")));
await page.click("#instTabs button[data-tab=departments]");
await page.fill("#deptNameInput", "Economics"); await page.click("#addDeptBtn");
check("after adding, points to 'Old records'", /Old records/.test(await h.alertText()));
await page.click("#instTabs button[data-tab=upgrade]");
await page.click("#upgradeBtn"); await h.dialog(); await h.ok();
await page.waitForFunction(() => /Done|Not finished/.test(document.getElementById("upgradeStatus").textContent), null, { timeout: 30000 });
const st = await page.textContent("#upgradeStatus");
check("records moved", /✅ Done: 10 records, 3 accounts and 1 closed day moved into Economics; 1 student can now also log in with their roll number/.test(st), st);
await page.screenshot({ path: `${SHOTS}/upgrade-admin.png`, fullPage: true });
await h.logout();

log("Old HOD works again");
await h.login("hod");
await page.waitForSelector("#hodDashboardSection.active");
await page.evaluate(() => showSection("reportsSection"));
await page.waitForFunction(() => document.querySelectorAll("#subjectFilter option").length > 1);
await page.fill("#fromDate", "2026-10-01"); await page.fill("#toDate", "2026-10-22");
await page.click("#generateBtn"); await page.waitForSelector("#reportOutput table");
const rep = (await page.textContent("#reportOutput")).replace(/\s+/g, " ");
check("old attendance in the report (Student One: 1 present, 0 absent, 1 leave)", /1 - Student One 1 0 1 100%/.test(rep), rep.slice(0, 220));
await page.evaluate(() => showSection("adminSection"));
await page.click("#adminTabs button[data-tab=closures]");
await page.waitForFunction(() => /Old snow day/.test(document.getElementById("closedDayList").textContent));
check("old closed day is now the department's (with Remove)", await page.isVisible("#closedDayList button"));
await page.click("#adminTabs button[data-tab=settings]");
await page.click("#rebuildViewsBtn");
await page.waitForFunction(() => /Rebuilt|FAILED/.test(document.getElementById("rebuildViewsStatus").textContent), null, { timeout: 20000 });
check("HOD rebuilds student copies", /Rebuilt 2 /.test(await page.textContent("#rebuildViewsStatus")), await page.textContent("#rebuildViewsStatus"));
await h.logout();

log("Student logs in with old ID and with roll number");
for (const id of ["ug2025-1", "1"]) {
  await h.login(id);
  await page.waitForFunction(() => /Microeconomics/.test(document.getElementById("studentDashboardOutput").textContent), null, { timeout: 15000 });
  const d = (await page.textContent("#studentDashboardOutput")).replace(/\s+/g, " ");
  check(`login '${id}': 1 / 1 (+1 leave)`, /Microeconomics \[MAJOR\] 1 \/ 1 \(\+1 leave\)/.test(d), d.slice(0, 200));
  await h.logout();
}

log("Teacher marks a new class");
await h.login("t1");
await page.waitForFunction(() => document.querySelectorAll("#subjectSelect option").length > 1);
await page.selectOption("#subjectSelect", SUBJ);
await page.fill("#attendanceDate", "2026-10-19");
await page.waitForSelector("#attendanceTable tbody tr");
await page.click("#saveBtn");
const msg = await h.alertText();
check("saves after the upgrade", /saved successfully/.test(msg) && !/⚠️/.test(msg), msg);
await page.fill("#attendanceDate", "2026-10-16");
await page.waitForFunction(() => /Day is closed/.test(document.getElementById("student-list").textContent));
check("old closed day still closed", true);
await h.logout();
await h.finish();
