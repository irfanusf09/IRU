// Tests for firestore.rules, run against Google's Firestore emulator.
//   cd tests && npm install && npm test
// Every test starts from the same small institution (see seed()):
//   Economics (ECO) and Physics (PHY); a student of ECO takes a PHY Minor.
import { test, before, after, beforeEach } from "node:test";
import fs from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";
import firebase from "firebase/compat/app";
import "firebase/compat/firestore";
const serverTime = () => firebase.firestore.FieldValue.serverTimestamp();
const minutesAgo = m => firebase.firestore.Timestamp.fromMillis(Date.now() - m * 60000);

const MONDAY = "2026-10-19";
const TUESDAY = "2026-10-20";
const SUNDAY = "2026-10-18";
const FRIDAY = "2026-10-23";          // closed for Physics only
const FUTURE = "2099-01-05";          // a Monday, far in the future

const SUBJECT = "1700000000001";        // ECO, taught by t1, semester ACTIVE
const OTHER_SUBJECT = "1700000000002";  // ECO, taught by t2
const CLOSED_SUBJECT = "1700000000003"; // ECO, taught by t1, semester CLOSED
const PHY_SUBJECT = "1800000000001";    // PHY Minor, taught by tp
const STUDENTS = Array.from({ length: 60 }, (_, i) => String(1700000000100 + i + 0.25));
const ME = STUDENTS[0], CLASSMATE = STUDENTS[1];

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-attendance",
    firestore: { rules: fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"), host: "127.0.0.1", port: 8080 }
  });
});
after(async () => { await env.cleanup(); });
beforeEach(async () => { await env.clearFirestore(); await seed(); });

async function seed() {
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    const set = (path, data) => db.doc(path).set(data);
    await set("config/institution", { adminUid: "admin", name: "Test College" });
    await set("departments/ECO", { name: "Economics", programs: ["UG"] });
    await set("departments/PHY", { name: "Physics", programs: ["UG"] });
    await set("users/admin", { role: "Admin", active: true });
    await set("users/principal", { role: "Principal", active: true });
    await set("users/hod", { role: "HOD", active: true, departmentId: "ECO" });
    await set("users/hodphy", { role: "HOD", active: true, departmentId: "PHY" });
    await set("users/t1", { role: "Teacher", active: true, teacherId: "T1", departmentId: "ECO" });
    await set("users/t2", { role: "Teacher", active: true, teacherId: "T2", departmentId: "ECO" });
    await set("users/tp", { role: "Teacher", active: true, teacherId: "TP", departmentId: "PHY" });
    await set("users/s1", { role: "Student", active: true, studentDocId: ME, departmentId: "ECO" });
    await set("loginNames/t1", { email: "t1@x", uid: "t1", departmentId: "ECO" });
    await set("loginNames/tp", { email: "tp@x", uid: "tp", departmentId: "PHY" });
    await set("teachers/T1", { id: "T1", departmentId: "ECO" });
    await set("teachers/T2", { id: "T2", departmentId: "ECO" });
    await set("teachers/TP", { id: "TP", departmentId: "PHY" });
    await set(`students/${ME}`, { id: Number(ME), departmentId: "ECO" });
    await set("batches/1700000000000_3", { id: 1700000000000, semester: "3", status: "ACTIVE", departmentId: "ECO" });
    await set("batches/1700000000000_2", { id: 1700000000000, semester: "2", status: "CLOSED", departmentId: "ECO" });
    await set("batches/1800000000000_3", { id: 1800000000000, semester: "3", status: "ACTIVE", departmentId: "PHY" });
    await set(`subjects/${SUBJECT}`, { id: Number(SUBJECT), batchId: 1700000000000, semester: "3", departmentId: "ECO" });
    await set(`subjects/${OTHER_SUBJECT}`, { id: Number(OTHER_SUBJECT), batchId: 1700000000000, semester: "3", departmentId: "ECO" });
    await set(`subjects/${CLOSED_SUBJECT}`, { id: Number(CLOSED_SUBJECT), batchId: 1700000000000, semester: "2", departmentId: "ECO" });
    await set(`subjects/${PHY_SUBJECT}`, { id: Number(PHY_SUBJECT), batchId: 1800000000000, semester: "3", departmentId: "PHY" });
    await set(`subjectAssignments/${SUBJECT}`, { subjectId: SUBJECT, teacherId: "T1", departmentId: "ECO" });
    await set(`subjectAssignments/${OTHER_SUBJECT}`, { subjectId: OTHER_SUBJECT, teacherId: "T2", departmentId: "ECO" });
    await set(`subjectAssignments/${CLOSED_SUBJECT}`, { subjectId: CLOSED_SUBJECT, teacherId: "T1", departmentId: "ECO" });
    await set(`subjectAssignments/${PHY_SUBJECT}`, { subjectId: PHY_SUBJECT, teacherId: "TP", departmentId: "PHY" });
    await set(`enrollments/${PHY_SUBJECT}`, { subjectId: PHY_SUBJECT, students: [Number(ME)], departmentId: "PHY" });
    await set("dayStatuses/2026-10-21", { date: "2026-10-21", type: "weather", reason: "Snow", departmentId: "ALL" });
    await set(`dayStatuses/PHY_${FRIDAY}`, { date: FRIDAY, type: "event", reason: "Physics fest", departmentId: "PHY" });
    await set(`classCancellations/${SUBJECT}_2026-10-22`, { subjectId: SUBJECT, date: "2026-10-22", departmentId: "ECO" });
    // Already-saved attendance for Tuesday, with ME absent and on leave
    const records = Object.fromEntries(STUDENTS.map(s => [s, "Present"]));
    records[ME] = "Absent";
    await set(`attendance/${SUBJECT}_${TUESDAY}`, { subjectId: SUBJECT, date: TUESDAY, records, markedBy: "T1", departmentId: "ECO" });
    await set(`attendance/${PHY_SUBJECT}_${TUESDAY}`, { subjectId: PHY_SUBJECT, date: TUESDAY, records: { [ME]: "Present" }, markedBy: "TP", departmentId: "PHY" });
    await set(`leaves/${SUBJECT}_${TUESDAY}_${ME}`, { subjectId: SUBJECT, date: TUESDAY, studentId: ME, type: "MEDICAL", departmentId: "ECO" });
    await set("attendanceCorrections/c1", { subjectId: SUBJECT, date: TUESDAY, studentId: ME, decision: "Approved", departmentId: "ECO" });
    await set("correctionRequests/r1", { subjectId: SUBJECT, date: TUESDAY, studentId: ME, status: "pending", requestedBy: "T1", departmentId: "ECO" });
    await set(`studentViews/${ME}_${SUBJECT}`, { studentId: ME, subjectId: SUBJECT, departmentId: "ECO", days: { [TUESDAY]: "Absent" }, leaves: {}, corrections: {}, last: TUESDAY });
    await set(`studentViews/${ME}_${PHY_SUBJECT}`, { studentId: ME, subjectId: PHY_SUBJECT, departmentId: "PHY", days: { [TUESDAY]: "Present" }, last: TUESDAY });
    await set(`studentViews/${CLASSMATE}_${SUBJECT}`, { studentId: CLASSMATE, subjectId: SUBJECT, departmentId: "ECO", days: { [TUESDAY]: "Present" }, last: TUESDAY });
    // Records from before departments existed
    await set("batches/legacy_1", { id: "legacy", semester: "1", status: "ACTIVE" });
    await set("attendance/legacy_2026-01-05", { subjectId: "legacy", date: "2026-01-05", records: {} });
  });
}

const as = uid => env.authenticatedContext(uid).firestore();
const attendance = (subjectId, date, records = { [ME]: "Present" }, departmentId = "ECO") =>
  ({ subjectId, date, records, markedBy: "T1", timestamp: 1, markedAt: "x", departmentId, savedAt: serverTime() });
const dayView = (studentId, subjectId, date, status, departmentId = "ECO") =>
  ({ studentId, subjectId, departmentId, days: { [date]: status }, last: date });

// ---------- Marking attendance ----------
test("teacher can mark their own class on a normal past weekday", async () => {
  await assertSucceeds(as("t1").doc(`attendance/${SUBJECT}_${MONDAY}`).set(attendance(SUBJECT, MONDAY)));
});

test("teacher can mark on a day another department closed", async () => {
  await assertSucceeds(as("t1").doc(`attendance/${SUBJECT}_${FRIDAY}`).set(attendance(SUBJECT, FRIDAY)));
});

for (const [why, uid, subjectId, date, dept] of [
  ["on a Sunday", "t1", SUBJECT, SUNDAY, "ECO"],
  ["for a future date", "t1", SUBJECT, FUTURE, "ECO"],
  ["on a day the institution closed", "t1", SUBJECT, "2026-10-21", "ECO"],
  ["on a day their department closed", "tp", PHY_SUBJECT, FRIDAY, "PHY"],
  ["for a class marked not held", "t1", SUBJECT, "2026-10-22", "ECO"],
  ["in a semester that is not ACTIVE", "t1", CLOSED_SUBJECT, MONDAY, "ECO"],
  ["for a subject they don't teach", "t1", OTHER_SUBJECT, MONDAY, "ECO"],
  ["for another department's subject", "t1", PHY_SUBJECT, MONDAY, "PHY"],
  ["tagged with another department", "t1", SUBJECT, MONDAY, "PHY"]
]) {
  test(`teacher cannot mark attendance ${why}`, async () => {
    const data = attendance(subjectId, date, { [ME]: "Present" }, dept);
    await assertFails(as(uid).doc(`attendance/${subjectId}_${date}`).set(data));
  });
}

test("attendance must carry the server's save time", async () => {
  const { savedAt, ...noTime } = attendance(SUBJECT, MONDAY);
  await assertFails(as("t1").doc(`attendance/${SUBJECT}_${MONDAY}`).set(noTime));
  await assertFails(as("t1").doc(`attendance/${SUBJECT}_${MONDAY}`).set({ ...noTime, savedAt: minutesAgo(-30) }));   // a made-up time
  await assertFails(as("t1").doc(`attendance/${SUBJECT}_${MONDAY}`).set({ ...attendance(SUBJECT, MONDAY), originalRecords: {} }));
});

test("saved attendance cannot be changed or deleted", async () => {
  const ref = as("t1").doc(`attendance/${SUBJECT}_${TUESDAY}`);
  await assertFails(ref.set(attendance(SUBJECT, TUESDAY)));
  await assertFails(ref.delete());
  await assertFails(as("hod").doc(`attendance/${SUBJECT}_${TUESDAY}`).delete());
  await assertFails(as("admin").doc(`attendance/${SUBJECT}_${TUESDAY}`).update({ markedBy: "x" }));
});

test("only teachers mark attendance (not HOD, Admin or Principal)", async () => {
  for (const uid of ["hod", "admin", "principal"]) {
    await assertFails(as(uid).doc(`attendance/${SUBJECT}_${MONDAY}`).set(attendance(SUBJECT, MONDAY)));
  }
});

// ---------- Edit window: the teacher who saved may change marks for a while ----------
const SAVED = { [ME]: "Absent", [CLASSMATE]: "Present" };
async function savedClass(minutes, extra = {}, subjectId = SUBJECT) {
  await env.withSecurityRulesDisabled(ctx => ctx.firestore().doc(`attendance/${subjectId}_${MONDAY}`).set({
    subjectId, date: MONDAY, records: SAVED, markedBy: "T1", departmentId: "ECO", savedAt: minutesAgo(minutes), ...extra }));
}
const edit = (records, original = SAVED, by = "T1") =>
  ({ records, originalRecords: original, editedAt: serverTime(), editedBy: by });
const setWindow = m => env.withSecurityRulesDisabled(ctx => ctx.firestore().doc("config/settings").set({ editWindowMinutes: m }));
const istMinutesToday = () => { const d = new Date(Date.now() + 330 * 60000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };

test("teacher corrects a mark soon after saving; the first marks are kept", async () => {
  await savedClass(10);
  const ref = as("t1").doc(`attendance/${SUBJECT}_${MONDAY}`);
  if (istMinutesToday() < 11) return;                       // saved before midnight: nothing to test
  await assertSucceeds(ref.update(edit({ [ME]: "Present", [CLASSMATE]: "Present" })));
  // a second change must keep the first-saved marks
  await assertFails(ref.update(edit({ [ME]: "Absent", [CLASSMATE]: "Present" }, { [ME]: "Present", [CLASSMATE]: "Present" })));
  await assertSucceeds(ref.update(edit({ [ME]: "Absent", [CLASSMATE]: "Absent" })));
});

test("no change after the window (default 60 minutes)", async () => {
  await savedClass(61);
  await assertFails(as("t1").doc(`attendance/${SUBJECT}_${MONDAY}`).update(edit({ [ME]: "Present", [CLASSMATE]: "Present" })));
});

test("the Institution Admin's window setting applies", async () => {
  await setWindow(90);
  await savedClass(75);
  if (istMinutesToday() >= 76) {
    await assertSucceeds(as("t1").doc(`attendance/${SUBJECT}_${MONDAY}`).update(edit({ [ME]: "Present", [CLASSMATE]: "Present" })));
  }
  await setWindow(0);
  await savedClass(1);
  await assertFails(as("t1").doc(`attendance/${SUBJECT}_${MONDAY}`).update(edit({ [ME]: "Present", [CLASSMATE]: "Present" })));
});

test("no change after midnight (India time) of the day it was saved", async () => {
  await setWindow(1440);
  await savedClass(istMinutesToday() + 1);                   // saved at 23:59 yesterday, India time
  await assertFails(as("t1").doc(`attendance/${SUBJECT}_${MONDAY}`).update(edit({ [ME]: "Present", [CLASSMATE]: "Present" })));
});

test("only the teacher who saved, only the marks", async () => {
  await savedClass(5);
  const ref = s => as(s).doc(`attendance/${SUBJECT}_${MONDAY}`);
  await assertFails(ref("t2").update(edit({ [ME]: "Present", [CLASSMATE]: "Present" }, SAVED, "T2")));
  await assertFails(ref("hod").update(edit({ [ME]: "Present", [CLASSMATE]: "Present" })));
  await assertFails(ref("t1").update(edit({ [ME]: "Present" })));                                         // drops a student
  await assertFails(ref("t1").update(edit({ [ME]: "Present", [CLASSMATE]: "Present", [STUDENTS[5]]: "Present" })));   // adds one
  await assertFails(ref("t1").update(edit({ [ME]: "Present", [CLASSMATE]: "Present" }, { [ME]: "Present", [CLASSMATE]: "Present" })));   // rewrites the first marks
  await assertFails(ref("t1").update({ ...edit({ [ME]: "Present", [CLASSMATE]: "Present" }), date: TUESDAY }));
  await assertFails(ref("t1").update({ ...edit({ [ME]: "Present", [CLASSMATE]: "Present" }), editedAt: minutesAgo(0) }));
  await assertFails(ref("t1").update(edit({ [ME]: "Present", [CLASSMATE]: "Present" }, SAVED, "T2")));
  await assertFails(ref("t1").delete());
});

test("a teacher newly assigned to the subject can't change the previous teacher's marks", async () => {
  await savedClass(5, {}, OTHER_SUBJECT);                    // marked by T1, now taught by T2
  await assertFails(as("t2").doc(`attendance/${OTHER_SUBJECT}_${MONDAY}`).update(edit({ [ME]: "Present", [CLASSMATE]: "Present" }, SAVED, "T2")));
});

test("records saved before the window existed (no save time) stay locked", async () => {
  await assertFails(as("t1").doc(`attendance/${SUBJECT}_${TUESDAY}`).update({
    records: { [ME]: "Present" }, originalRecords: {}, editedAt: serverTime(), editedBy: "T1" }));
});

test("the class summary changes only together with an edit", async () => {
  await savedClass(5);
  if (istMinutesToday() < 6) return;
  const db = as("t1");
  const sum = (present, absent) => ({ departmentId: "ECO", subjectId: SUBJECT, date: MONDAY, subjectName: "x", teacherId: "T1",
    teacherName: "t", present, absent, leave: 0, markedAt: "x" });
  await env.withSecurityRulesDisabled(ctx => ctx.firestore().doc(`classSummaries/${SUBJECT}_${MONDAY}`).set(sum(1, 1)));
  await assertFails(db.doc(`classSummaries/${SUBJECT}_${MONDAY}`).set(sum(2, 0)));                       // alone
  const b = db.batch();
  b.update(db.doc(`attendance/${SUBJECT}_${MONDAY}`), edit({ [ME]: "Present", [CLASSMATE]: "Present" }));
  b.set(db.doc(`classSummaries/${SUBJECT}_${MONDAY}`), sum(2, 0));
  b.set(db.doc(`studentViews/${ME}_${SUBJECT}`), dayView(ME, SUBJECT, MONDAY, "Present"), { merge: true });
  await assertSucceeds(b.commit());
});

// ---------- Teacher writes students' copies ----------
test("teacher saves a 60-student class, every student's copy and the summary in one batch", async () => {
  const db = as("t1");
  const records = Object.fromEntries(STUDENTS.map((s, i) => [s, i % 3 ? "Present" : "Absent"]));
  const b = db.batch();
  b.set(db.doc(`attendance/${SUBJECT}_${MONDAY}`), attendance(SUBJECT, MONDAY, records));
  STUDENTS.forEach(s => b.set(db.doc(`studentViews/${s}_${SUBJECT}`), dayView(s, SUBJECT, MONDAY, records[s]), { merge: true }));
  b.set(db.doc(`classSummaries/${SUBJECT}_${MONDAY}`), {
    departmentId: "ECO", subjectId: SUBJECT, date: MONDAY, subjectName: "x", teacherId: "T1", teacherName: "t",
    present: 40, absent: 20, leave: 0, markedAt: "x" });
  await assertSucceeds(b.commit());
});

test("teacher cannot write a copy that differs from the saved attendance", async () => {
  const db = as("t1");
  const b = db.batch();
  b.set(db.doc(`attendance/${SUBJECT}_${MONDAY}`), attendance(SUBJECT, MONDAY, { [ME]: "Absent" }));
  b.set(db.doc(`studentViews/${ME}_${SUBJECT}`), dayView(ME, SUBJECT, MONDAY, "Present"), { merge: true });
  await assertFails(b.commit());
});

test("teacher cannot write a copy for a day with no saved attendance", async () => {
  await assertFails(as("t1").doc(`studentViews/${ME}_${SUBJECT}`).set(dayView(ME, SUBJECT, MONDAY, "Present"), { merge: true }));
});

test("teacher cannot change an existing day in a copy", async () => {
  await assertFails(as("t1").doc(`studentViews/${ME}_${SUBJECT}`).set(dayView(ME, SUBJECT, TUESDAY, "Present"), { merge: true }));
});

test("teacher cannot write corrections into a copy", async () => {
  await assertFails(as("t1").doc(`studentViews/${ME}_${SUBJECT}`)
    .set({ studentId: ME, subjectId: SUBJECT, departmentId: "ECO", corrections: { [TUESDAY]: "Present" }, last: TUESDAY }, { merge: true }));
});

test("teacher cannot write copies for a subject they don't teach", async () => {
  await assertFails(as("t2").doc(`studentViews/${ME}_${SUBJECT}`).set(dayView(ME, SUBJECT, TUESDAY, "Absent"), { merge: true }));
});

test("teacher can add a leave to a copy only if it matches the leave record", async () => {
  const ref = as("t1").doc(`studentViews/${ME}_${SUBJECT}`);
  await assertFails(ref.set({ studentId: ME, subjectId: SUBJECT, departmentId: "ECO", leaves: { [TUESDAY]: "CASUAL" }, last: TUESDAY }, { merge: true }));
  await assertSucceeds(ref.set({ studentId: ME, subjectId: SUBJECT, departmentId: "ECO", leaves: { [TUESDAY]: "MEDICAL" }, last: TUESDAY }, { merge: true }));
});

test("HOD can write copies of their department, not another's", async () => {
  await assertSucceeds(as("hod").doc(`studentViews/${ME}_${SUBJECT}`)
    .set({ studentId: ME, subjectId: SUBJECT, departmentId: "ECO", corrections: { [TUESDAY]: "Present" } }, { merge: true }));
  await assertFails(as("hod").doc(`studentViews/${ME}_${PHY_SUBJECT}`)
    .set({ studentId: ME, subjectId: PHY_SUBJECT, departmentId: "PHY", corrections: { [TUESDAY]: "Absent" } }, { merge: true }));
});

// ---------- Daily class summaries ----------
const summary = (subjectId, date, present, absent, leave = 0, departmentId = "ECO") =>
  ({ departmentId, subjectId, date, subjectName: "x", teacherId: "T1", teacherName: "t", present, absent, leave, markedAt: "x" });

test("teacher saves the class summary with the attendance; the counts must add up", async () => {
  const db = as("t1");
  const records = { [ME]: "Absent", [CLASSMATE]: "Present", [STUDENTS[2]]: "Present" };
  const bad = db.batch();
  bad.set(db.doc(`attendance/${SUBJECT}_${MONDAY}`), attendance(SUBJECT, MONDAY, records));
  bad.set(db.doc(`classSummaries/${SUBJECT}_${MONDAY}`), summary(SUBJECT, MONDAY, 3, 1));          // 4 ≠ 3 students
  await assertFails(bad.commit());
  const good = db.batch();
  good.set(db.doc(`attendance/${SUBJECT}_${MONDAY}`), attendance(SUBJECT, MONDAY, records));
  good.set(db.doc(`classSummaries/${SUBJECT}_${MONDAY}`), summary(SUBJECT, MONDAY, 2, 0, 1));
  await assertSucceeds(good.commit());
  await assertFails(db.doc(`classSummaries/${SUBJECT}_${MONDAY}`).update({ present: 3, leave: 0 }));   // teachers can't change it later
});

test("no summary without saved attendance, or for another department", async () => {
  await assertFails(as("t1").doc(`classSummaries/${SUBJECT}_${MONDAY}`).set(summary(SUBJECT, MONDAY, 1, 0)));
  await assertFails(as("t1").doc(`classSummaries/${PHY_SUBJECT}_${TUESDAY}`).set(summary(PHY_SUBJECT, TUESDAY, 1, 0, 0, "PHY")));
  await assertFails(as("t1").doc(`classSummaries/${SUBJECT}_${TUESDAY}`).set(summary(SUBJECT, TUESDAY, 60, 0, 0, "PHY")));
});

test("HOD recomputes their department's summaries; reading follows departments", async () => {
  await assertSucceeds(as("hod").doc(`classSummaries/${SUBJECT}_${TUESDAY}`).set(summary(SUBJECT, TUESDAY, 59, 0, 1)));
  await assertSucceeds(as("hod").doc(`classSummaries/${SUBJECT}_${TUESDAY}`).set(summary(SUBJECT, TUESDAY, 59, 1, 0)));
  await assertFails(as("hodphy").doc(`classSummaries/${SUBJECT}_${TUESDAY}`).set(summary(SUBJECT, TUESDAY, 59, 1, 0)));
  await assertSucceeds(as("hod").collection("classSummaries").where("departmentId", "==", "ECO").get());
  await assertFails(as("hod").collection("classSummaries").where("date", "==", TUESDAY).get());
  await assertSucceeds(as("principal").collection("classSummaries").where("date", "==", TUESDAY).get());
  await assertFails(as("principal").doc(`classSummaries/${SUBJECT}_${TUESDAY}`).set(summary(SUBJECT, TUESDAY, 59, 1, 0)));
  await assertFails(as("s1").collection("classSummaries").where("departmentId", "==", "ECO").get());
});

// ---------- What a student can read ----------
test("student can read their own copies, including another department's subject", async () => {
  const db = as("s1");
  const snap = await assertSucceeds(db.collection("studentViews").where("studentId", "==", ME).get());
  if (snap.size !== 2) throw new Error("expected 2 copies, got " + snap.size);
  await assertSucceeds(db.doc(`studentViews/${ME}_${PHY_SUBJECT}`).get());
});

test("student cannot read a classmate's copy", async () => {
  const db = as("s1");
  await assertFails(db.collection("studentViews").where("studentId", "==", CLASSMATE).get());
  await assertFails(db.collection("studentViews").get());
  await assertFails(db.doc(`studentViews/${CLASSMATE}_${SUBJECT}`).get());
});

test("student cannot read class attendance, leaves or corrections", async () => {
  const db = as("s1");
  await assertFails(db.doc(`attendance/${SUBJECT}_${TUESDAY}`).get());
  await assertFails(db.collection("attendance").where("departmentId", "==", "ECO").get());
  await assertFails(db.collection("leaves").where("departmentId", "==", "ECO").get());
  await assertFails(db.collection("attendanceCorrections").where("departmentId", "==", "ECO").get());
});

test("student cannot write their own copy", async () => {
  await assertFails(as("s1").doc(`studentViews/${ME}_${SUBJECT}`).set(dayView(ME, SUBJECT, TUESDAY, "Present"), { merge: true }));
});

test("student can still read class-level data for their dashboard", async () => {
  const db = as("s1");
  await assertSucceeds(db.collection("subjects").get());
  await assertSucceeds(db.collection("departments").get());
  await assertSucceeds(db.collection("dayStatuses").where("departmentId", "in", ["ALL", "ECO", "PHY"]).get());
  await assertSucceeds(db.collection("classCancellations").get());
  await assertSucceeds(db.collection("enrollments").where("students", "array-contains", Number(ME)).get());
});

// ---------- Reading across departments ----------
test("staff read their own department's attendance, leaves and corrections", async () => {
  for (const uid of ["hod", "t1"]) {
    const db = as(uid);
    await assertSucceeds(db.collection("attendance").where("departmentId", "==", "ECO").get());
    await assertSucceeds(db.collection("leaves").where("departmentId", "==", "ECO").get());
    await assertSucceeds(db.collection("attendanceCorrections").where("departmentId", "==", "ECO").get());
    await assertSucceeds(db.collection("correctionRequests").where("departmentId", "==", "ECO").get());
    await assertSucceeds(db.doc(`attendance/${SUBJECT}_${TUESDAY}`).get());
  }
});

test("staff cannot read another department's attendance, leaves, corrections or copies", async () => {
  for (const uid of ["hod", "t1"]) {
    const db = as(uid);
    await assertFails(db.collection("attendance").where("departmentId", "==", "PHY").get());
    await assertFails(db.collection("attendance").get());
    await assertFails(db.doc(`attendance/${PHY_SUBJECT}_${TUESDAY}`).get());
    await assertFails(db.collection("leaves").get());
    await assertFails(db.collection("correctionRequests").get());
    await assertFails(db.doc(`studentViews/${ME}_${PHY_SUBJECT}`).get());
  }
});

test("staff can check that attendance doesn't exist yet", async () => {
  await assertSucceeds(as("t1").doc(`attendance/${SUBJECT}_${MONDAY}`).get());
  await assertSucceeds(as("hod").doc(`attendance/${SUBJECT}_${MONDAY}`).get());
});

test("the offering department sees its Minor attendance, including other departments' students", async () => {
  const db = as("hodphy");
  await assertSucceeds(db.doc(`attendance/${PHY_SUBJECT}_${TUESDAY}`).get());
  await assertSucceeds(db.doc(`studentViews/${ME}_${PHY_SUBJECT}`).get());
  await assertSucceeds(db.doc(`students/${ME}`).get());         // name/roll of an ECO student
  await assertSucceeds(as("tp").collection("students").where("roll", "==", "1").get());
});

test("Principal and Admin read every department", async () => {
  for (const uid of ["principal", "admin"]) {
    const db = as(uid);
    await assertSucceeds(db.collection("attendance").get());
    await assertSucceeds(db.collection("leaves").get());
    await assertSucceeds(db.collection("studentViews").get());
    await assertSucceeds(db.collection("students").get());
    await assertSucceeds(db.collection("teachers").get());
  }
});

test("Principal changes nothing", async () => {
  const db = as("principal");
  await assertFails(db.doc("batches/x_1").set({ departmentId: "ECO", id: "x", semester: "1" }));
  await assertFails(db.doc("dayStatuses/2026-11-02").set({ date: "2026-11-02", departmentId: "ALL" }));
  await assertFails(db.doc("departments/NEW").set({ name: "New" }));
  await assertFails(db.doc("users/principal").update({ role: "Admin" }));
  await assertFails(db.doc("config/settings").set({ casualLeaveLimit: 9 }));
  await assertFails(db.doc("correctionRequests/r1").update({ status: "approved" }));
});

// ---------- HODs manage only their department ----------
test("HOD manages their own department's setup", async () => {
  const db = as("hod");
  await assertSucceeds(db.doc("batches/1700000000000_4").set({ id: 1700000000000, semester: "4", status: "ACTIVE", departmentId: "ECO" }));
  await assertSucceeds(db.doc("subjects/9").set({ id: 9, batchId: 1700000000000, semester: "3", departmentId: "ECO" }));
  await assertSucceeds(db.doc(`enrollments/${SUBJECT}`).set({ subjectId: SUBJECT, students: [Number(ME)], departmentId: "ECO" }));
  await assertSucceeds(db.doc("teachers/T9").set({ id: "T9", departmentId: "ECO" }));
  await assertSucceeds(db.doc("students/99").set({ id: 99, departmentId: "ECO" }));
  await assertSucceeds(db.doc(`subjectAssignments/${OTHER_SUBJECT}`).set({ subjectId: OTHER_SUBJECT, teacherId: "T1", departmentId: "ECO" }));
});

test("HOD cannot touch another department's setup", async () => {
  const db = as("hod");
  await assertFails(db.doc("batches/1800000000000_4").set({ id: 1800000000000, semester: "4", status: "ACTIVE", departmentId: "PHY" }));
  await assertFails(db.doc("batches/1800000000000_3").update({ status: "CLOSED" }));
  await assertFails(db.doc("batches/1800000000000_3").delete());
  await assertFails(db.doc(`subjects/${PHY_SUBJECT}`).update({ name: "x" }));
  await assertFails(db.doc(`enrollments/${PHY_SUBJECT}`).update({ students: [] }));
  await assertFails(db.doc("teachers/TP").update({ status: "FORMER" }));
  await assertFails(db.doc(`subjectAssignments/${PHY_SUBJECT}`).update({ teacherId: "T1" }));
});

test("HOD cannot move a record to another department", async () => {
  await assertFails(as("hod").doc("batches/1700000000000_3").update({ departmentId: "PHY" }));
  await assertFails(as("hod").doc(`students/${ME}`).update({ departmentId: "PHY" }));
});

test("HOD cannot put a subject in another department's batch", async () => {
  await assertFails(as("hod").doc("subjects/9").set({ id: 9, batchId: 1800000000000, semester: "3", departmentId: "ECO" }));
});

test("HOD cannot assign another department's teacher", async () => {
  await assertFails(as("hod").doc(`subjectAssignments/${OTHER_SUBJECT}`).set({ subjectId: OTHER_SUBJECT, teacherId: "TP", departmentId: "ECO" }));
});

test("HOD decides corrections of their own department only", async () => {
  await assertSucceeds(as("hod").doc("correctionRequests/r1").update({ status: "approved" }));
  await assertFails(as("hodphy").doc("correctionRequests/r1").update({ status: "approved" }));
  await assertSucceeds(as("hod").doc("attendanceCorrections/c2").set({ subjectId: SUBJECT, departmentId: "ECO", decision: "Approved" }));
  await assertFails(as("hodphy").doc("attendanceCorrections/c3").set({ subjectId: SUBJECT, departmentId: "ECO", decision: "Approved" }));
});

test("HOD removes leaves of their own department only", async () => {
  await assertFails(as("hodphy").doc(`leaves/${SUBJECT}_${TUESDAY}_${ME}`).delete());
  await assertSucceeds(as("hod").doc(`leaves/${SUBJECT}_${TUESDAY}_${ME}`).delete());
});

// ---------- Closed days ----------
test("HOD closes days for their own department only", async () => {
  await assertSucceeds(as("hod").doc("dayStatuses/ECO_2026-11-02").set({ date: "2026-11-02", departmentId: "ECO", reason: "x" }));
  await assertFails(as("hod").doc("dayStatuses/PHY_2026-11-02").set({ date: "2026-11-02", departmentId: "PHY", reason: "x" }));
  await assertFails(as("hod").doc("dayStatuses/2026-11-02").set({ date: "2026-11-02", departmentId: "ALL", reason: "x" }));
  await assertFails(as("hod").doc(`dayStatuses/PHY_${FRIDAY}`).delete());
  await assertFails(as("hod").doc("dayStatuses/2026-10-21").delete());
});

test("Admin closes days for the whole institution", async () => {
  await assertSucceeds(as("admin").doc("dayStatuses/2026-11-02").set({ date: "2026-11-02", departmentId: "ALL", reason: "Strike" }));
  await assertFails(as("admin").doc("dayStatuses/2026-11-03").set({ date: "2026-11-02", departmentId: "ALL", reason: "wrong id" }));
  await assertSucceeds(as("admin").doc("dayStatuses/2026-10-21").delete());
  // used when upgrading an old install: its closed days become the department's
  await assertSucceeds(as("admin").doc("dayStatuses/ECO_2026-11-04").set({ date: "2026-11-04", departmentId: "ECO", reason: "x" }));
  await assertFails(as("admin").doc("dayStatuses/NOPE_2026-11-04").set({ date: "2026-11-04", departmentId: "NOPE", reason: "x" }));
});

// ---------- Accounts ----------
test("HOD creates teacher and student accounts of their own department only", async () => {
  const db = as("hod");
  await assertSucceeds(db.doc("users/newT").set({ role: "Teacher", departmentId: "ECO", active: true, teacherId: "T9" }));
  await assertSucceeds(db.doc("users/newS").set({ role: "Student", departmentId: "ECO", active: true }));
  await assertFails(db.doc("users/x1").set({ role: "Teacher", departmentId: "PHY", active: true }));
  await assertFails(db.doc("users/x2").set({ role: "HOD", departmentId: "ECO", active: true }));
  await assertFails(db.doc("users/x3").set({ role: "Admin", active: true }));
  await assertFails(db.doc("users/x4").set({ role: "Principal", active: true }));
});

test("HOD cannot change other departments' accounts or promote anyone", async () => {
  const db = as("hod");
  await assertFails(db.doc("users/tp").update({ active: false }));
  await assertFails(db.doc("users/hodphy").update({ active: false }));
  await assertFails(db.doc("users/t1").update({ role: "HOD" }));
  await assertFails(db.doc("users/hod").update({ departmentId: "PHY" }));
  await assertSucceeds(db.doc("users/t1").update({ active: false }));
});

test("HOD lists and reads only their department's accounts", async () => {
  await assertSucceeds(as("hod").collection("users").where("departmentId", "==", "ECO").get());
  await assertFails(as("hod").collection("users").get());
  await assertFails(as("hod").doc("users/tp").get());
});

test("HOD manages login IDs of their own department only", async () => {
  await assertSucceeds(as("hod").doc("loginNames/newt").set({ email: "n@x", uid: "newT", departmentId: "ECO" }));
  await assertFails(as("hod").doc("loginNames/tp").set({ email: "evil@x", uid: "t1", departmentId: "ECO" }));
  await assertFails(as("hod").doc("loginNames/tp").delete());
  await assertFails(as("hod").doc("loginNames/x").set({ email: "n@x", uid: "x", departmentId: "PHY" }));
});

test("Admin creates departments, HODs and Principals, and sets institution rules", async () => {
  const db = as("admin");
  await assertSucceeds(db.doc("departments/CHE").set({ name: "Chemistry", programs: ["UG"] }));
  await assertSucceeds(db.doc("users/newHod").set({ role: "HOD", departmentId: "CHE", active: true }));
  await assertSucceeds(db.doc("users/newP").set({ role: "Principal", active: true }));
  await assertSucceeds(db.doc("loginNames/hodche").set({ email: "c@x", uid: "newHod", departmentId: "CHE" }));
  await assertSucceeds(db.doc("config/settings").set({ casualLeaveLimit: 5 }));
  await assertFails(as("hod").doc("config/settings").set({ casualLeaveLimit: 50 }));
  await assertFails(as("hod").doc("departments/CHE").set({ name: "x" }));
});

test("Admin doesn't run departments' records", async () => {
  const db = as("admin");
  await assertFails(db.doc("batches/1700000000000_3").update({ status: "CLOSED" }));
  await assertFails(db.doc(`subjects/${SUBJECT}`).update({ name: "x" }));
  await assertFails(db.doc("correctionRequests/r1").update({ status: "approved" }));
});

test("anyone may sign in with a login ID, nobody may list them", async () => {
  await assertSucceeds(env.unauthenticatedContext().firestore().doc("loginNames/t1").get());
  await assertFails(env.unauthenticatedContext().firestore().collection("loginNames").get());
  await assertFails(as("admin").collection("loginNames").get());
});

test("not logged in: no attendance and no copies", async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(db.collection("attendance").get());
  await assertFails(db.collection("studentViews").get());
  await assertFails(db.collection("students").get());
});

test("leave can still be recorded after attendance is saved", async () => {
  const db = as("t1");
  await assertSucceeds(db.doc(`leaves/${SUBJECT}_${TUESDAY}_${CLASSMATE}`).set({
    subjectId: SUBJECT, departmentId: "ECO", date: TUESDAY, studentId: CLASSMATE, type: "CASUAL", reference: "", markedBy: "T1", markedAt: "x"
  }));
  await assertFails(db.doc(`leaves/${SUBJECT}_${TUESDAY}_${STUDENTS[2]}`).set({
    subjectId: SUBJECT, departmentId: "PHY", date: TUESDAY, studentId: STUDENTS[2], type: "CASUAL", reference: "", markedBy: "T1", markedAt: "x"
  }));
});

test("teacher marks own class not held, not another department's", async () => {
  await assertSucceeds(as("t1").doc(`classCancellations/${SUBJECT}_${MONDAY}`).set({ subjectId: SUBJECT, date: MONDAY, departmentId: "ECO", reason: "x" }));
  await assertFails(as("t1").doc(`classCancellations/${PHY_SUBJECT}_${MONDAY}`).set({ subjectId: PHY_SUBJECT, date: MONDAY, departmentId: "ECO", reason: "x" }));
  await assertFails(as("hod").doc(`classCancellations/${PHY_SUBJECT}_${MONDAY}`).set({ subjectId: PHY_SUBJECT, date: MONDAY, departmentId: "PHY", reason: "x" }));
});

// ---------- Upgrading old records ----------
test("Admin tags old records with a department, and nothing else", async () => {
  const db = as("admin");
  await assertSucceeds(db.doc("batches/legacy_1").update({ departmentId: "ECO" }));
  await assertSucceeds(db.doc("attendance/legacy_2026-01-05").update({ departmentId: "ECO" }));
  await assertFails(db.doc("attendance/legacy_2026-01-05").update({ departmentId: "PHY" }));          // already tagged now
  await assertFails(db.doc("batches/legacy_1").update({ departmentId: "PHY", status: "CLOSED" }));
  await assertFails(db.doc(`batches/1700000000000_3`).update({ departmentId: "PHY" }));                // not old
});

test("Admin can't tag old records with a department that doesn't exist", async () => {
  await assertFails(as("admin").doc("batches/legacy_1").update({ departmentId: "NOPE" }));
});

test("nobody else may tag old records", async () => {
  await assertFails(as("hod").doc("batches/legacy_1").update({ departmentId: "ECO" }));
  await assertFails(as("principal").doc("attendance/legacy_2026-01-05").update({ departmentId: "ECO" }));
});

test("an HOD without a department (old install, not yet upgraded) can do nothing", async () => {
  await env.withSecurityRulesDisabled(ctx => ctx.firestore().doc("users/oldhod").set({ role: "HOD", active: true }));
  const db = as("oldhod");
  await assertFails(db.doc("batches/legacy_1").update({ status: "CLOSED" }));
  await assertFails(db.collection("attendance").get());
  await assertFails(db.doc("batches/z_1").set({ id: "z", semester: "1", status: "ACTIVE", departmentId: "" }));
});

// ---------- First-time setup ----------
async function setupBatch(db, adminUid) {
  const b = db.batch();
  b.set(db.doc(`users/${adminUid}`), { role: "Admin", active: true, mustChangePassword: false });
  b.set(db.doc("loginNames/admin2"), { email: "a@x", uid: adminUid });
  b.set(db.doc("config/institution"), { adminUid, name: "College" });
  return b.commit();
}
const removeInstitution = () => env.withSecurityRulesDisabled(ctx => ctx.firestore().doc("config/institution").delete());

test("new install: the first person to set up becomes the Institution Admin, once", async () => {
  await removeInstitution();
  await assertFails(setupBatch(as("someone"), "otherUid"));       // can't appoint someone else
  await assertSucceeds(setupBatch(as("newadmin"), "newadmin"));
  await assertFails(setupBatch(as("late"), "late"));               // already set up
});

test("old single-department install: only its HOD can appoint the Institution Admin", async () => {
  await removeInstitution();
  await env.withSecurityRulesDisabled(ctx => ctx.firestore().doc("config/hod").set({ uid: "oldhod" }));
  await env.withSecurityRulesDisabled(ctx => ctx.firestore().doc("users/oldhod").set({ role: "HOD", active: true }));
  await assertFails(setupBatch(as("intruder"), "intruder"));
  await assertSucceeds(setupBatch(as("oldhod"), "newadmin"));
});

test("nobody can create a second HOD setup or an Admin account by themselves", async () => {
  await assertFails(as("someone").doc("config/hod").set({ uid: "someone" }));
  await assertFails(as("someone").doc("users/someone").set({ role: "Admin", active: true }));
  await assertFails(as("someone").doc("users/someone").set({ role: "HOD", departmentId: "ECO", active: true }));
});
