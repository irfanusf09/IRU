// Edit window: the teacher changes saved marks for a while; registers mark it.
import { start, SHOTS } from "./harness.mjs";
import { tagAll } from "./tagall.mjs";
import firebase from "firebase/compat/app";
const h = await start({ viewport: { width: 390, height: 844 } });
const { page, admin, check, log } = h;
const SUBJ = "1700000000001", OTHER = "1700000000002";
const STU = [1700000000100.25, 1700000000101.5, 1700000000102.75];
const today = await (async () => new Date().toLocaleDateString("en-CA"))();
const uids = {};
for (const who of ["hod", "t1"]) uids[who] = await h.signUp(`${who}@users.attendance.example.com`);
await admin(async db => {
  const set = (p, d) => db.doc(p).set(d);
  await set(`users/${uids.hod}`, { role: "HOD", name: "Head", loginId: "hod", active: true });
  await set(`users/${uids.t1}`, { role: "Teacher", name: "Asha Bhat", loginId: "t1", teacherId: "T1", active: true });
  await set("loginNames/hod", { email: "hod@users.attendance.example.com", uid: uids.hod });
  await set("loginNames/t1", { email: "t1@users.attendance.example.com", uid: uids.t1 });
  await set("teachers/T1", { id: "T1", name: "Asha Bhat", username: "t1", status: "ACTIVE" });
  await set("batches/1700000000000_3", { id: 1700000000000, program: "UG", year: 2025, semester: "3", status: "ACTIVE" });
  for (const id of [SUBJ, OTHER]) {
    await set(`subjects/${id}`, { id: Number(id), name: id === SUBJ ? "Microeconomics" : "Statistics", batchId: 1700000000000, type: "MAJOR", program: "UG", semester: "3", year: 2025 });
    await set(`subjectAssignments/${id}`, { subjectId: id, teacherId: "T1", history: [] });
    await set(`enrollments/${id}`, { subjectId: id, students: STU });
  }
  for (const [i, id] of STU.entries()) await set(`students/${id}`, { id, name: `Student ${i + 1}`, roll: String(i + 1), batchId: 1700000000000, status: "ACTIVE" });
});
await tagAll(admin);
// Statistics was saved 61 minutes ago: locked
await admin(async db => db.doc(`attendance/${OTHER}_${today}`).set({ subjectId: OTHER, date: today, departmentId: "ECO",
  records: Object.fromEntries(STU.map(s => [String(s), "Present"])), markedBy: "T1", markedAt: "x",
  savedAt: firebase.firestore.Timestamp.fromMillis(Date.now() - 61 * 60000) }));

log("Teacher saves, then changes a mark within the window");
await h.login("t1");
await page.selectOption("#subjectSelect", SUBJ);
await page.fill("#attendanceDate", today);
await page.waitForSelector("#attendanceTable tbody tr");
await page.click(`#attendanceTable tr[data-student-id="${STU[1]}"] td:nth-child(3)`);   // Student 2 absent
await page.click("#saveBtn"); await h.alertText();
await page.waitForFunction(() => /Save changes/.test(document.getElementById("saveBtn").textContent));
check("after saving: 'Save changes' shown, disabled until something changes", await page.isVisible("#saveBtn") && await page.isDisabled("#saveBtn"));
check("tells until when", /until \d/.test(await page.textContent("#saveStatus")), await page.textContent("#saveStatus"));
await page.click(`#attendanceTable tr[data-student-id="${STU[1]}"] td:nth-child(3)`);   // late arrival: present after all
check("changed row marked ✎, Save enabled", await page.$eval(`#attendanceTable tr[data-student-id="${STU[1]}"]`, tr => tr.classList.contains("is-changed")) && !(await page.isDisabled("#saveBtn")));
await page.screenshot({ path: `${SHOTS}/edit-window-phone.png` });
await page.click("#saveBtn");
const msg = await h.alertText();
check("changes saved", /Changes saved \(1 student\)/.test(msg) && /Present: 3 \| Absent: 0/.test(msg), msg);
let a, v, s;
await admin(async db => {
  a = (await db.doc(`attendance/${SUBJ}_${today}`).get()).data();
  v = (await db.doc(`studentViews/${STU[1]}_${SUBJ}`).get()).data();
  s = (await db.doc(`classSummaries/${SUBJ}_${today}`).get()).data();
});
check("record now Present, first-saved mark kept", a.records[String(STU[1])] === "Present" && a.originalRecords[String(STU[1])] === "Absent" && a.editedBy === "T1");
check("student's copy updated", v.days[today] === "Present");
check("class summary updated (3 present, 0 absent)", s.present === 3 && s.absent === 0, JSON.stringify(s));

log("Locked after the window");
await page.selectOption("#subjectSelect", OTHER);
await page.waitForFunction(() => /Request Correction/.test(document.getElementById("student-list").textContent));
check("61 minutes after saving: no 'Save changes', Request Correction instead", !(await page.isVisible("#saveBtn")) && /Changes go through Request Correction/.test(await page.textContent("#saveStatus")));
await h.logout();

log("Register marks the change");
await page.setViewportSize({ width: 1280, height: 800 });
await h.login("hod");
await page.evaluate(() => showSection("reportsSection"));
await page.waitForSelector(`#subjectFilter option[value="${SUBJ}"]`, { state: "attached" });
await page.check("input[value=register]"); await page.selectOption("#subjectFilter", SUBJ);
await page.fill("#fromDate", today); await page.fill("#toDate", today);
await page.click("#generateBtn"); await page.waitForSelector("#registerOutput table");
const reg = (await page.textContent("#registerOutput")).replace(/\s+/g, " ");
check("register shows P† and the legend", /P†/.test(reg) && /† = changed by the teacher soon after saving/.test(reg), reg.slice(0, 300));
await page.evaluate(() => showSection("adminSection"));
await page.click("#adminTabs button[data-tab=settings]");
await page.waitForFunction(() => /60 minutes/.test(document.getElementById("editWindowShow").textContent));
check("HOD settings show the 60-minute window", true);
await h.logout();
await h.finish();
