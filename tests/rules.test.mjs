// Tests for firestore.rules, run against Google's Firestore emulator.
//   cd tests && npm install && npm test
// Every test starts from the same small department (see seed()).
import { test, before, after, beforeEach } from "node:test";
import fs from "node:fs";
import { initializeTestEnvironment, assertSucceeds, assertFails } from "@firebase/rules-unit-testing";

const MONDAY = "2026-10-19";
const TUESDAY = "2026-10-20";
const SUNDAY = "2026-10-18";
const FUTURE = "2099-01-05";          // a Monday, far in the future

const SUBJECT = "1700000000001";       // taught by teacher t1, semester ACTIVE
const OTHER_SUBJECT = "1700000000002"; // taught by teacher t2
const CLOSED_SUBJECT = "1700000000003"; // taught by t1, semester CLOSED
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
    await set("config/hod", { uid: "hod" });
    await set("users/hod", { role: "HOD", active: true });
    await set("users/t1", { role: "Teacher", active: true, teacherId: "T1" });
    await set("users/t2", { role: "Teacher", active: true, teacherId: "T2" });
    await set("users/s1", { role: "Student", active: true, studentDocId: ME });
    await set("batches/1700000000000_3", { id: 1700000000000, semester: "3", status: "ACTIVE" });
    await set("batches/1700000000000_2", { id: 1700000000000, semester: "2", status: "CLOSED" });
    await set(`subjects/${SUBJECT}`, { id: Number(SUBJECT), batchId: 1700000000000, semester: "3" });
    await set(`subjects/${OTHER_SUBJECT}`, { id: Number(OTHER_SUBJECT), batchId: 1700000000000, semester: "3" });
    await set(`subjects/${CLOSED_SUBJECT}`, { id: Number(CLOSED_SUBJECT), batchId: 1700000000000, semester: "2" });
    await set(`subjectAssignments/${SUBJECT}`, { subjectId: SUBJECT, teacherId: "T1" });
    await set(`subjectAssignments/${OTHER_SUBJECT}`, { subjectId: OTHER_SUBJECT, teacherId: "T2" });
    await set(`subjectAssignments/${CLOSED_SUBJECT}`, { subjectId: CLOSED_SUBJECT, teacherId: "T1" });
    await set("dayStatuses/2026-10-21", { type: "weather", reason: "Snow" });
    await set(`classCancellations/${SUBJECT}_2026-10-22`, { subjectId: SUBJECT, date: "2026-10-22" });
    // Already-saved attendance for Tuesday, with ME absent and on leave
    const records = Object.fromEntries(STUDENTS.map(s => [s, "Present"]));
    records[ME] = "Absent";
    await set(`attendance/${SUBJECT}_${TUESDAY}`, { subjectId: SUBJECT, date: TUESDAY, records, markedBy: "T1" });
    await set(`leaves/${SUBJECT}_${TUESDAY}_${ME}`, { subjectId: SUBJECT, date: TUESDAY, studentId: ME, type: "MEDICAL" });
    await set(`attendanceCorrections/c1`, { subjectId: SUBJECT, date: TUESDAY, studentId: ME, decision: "Approved" });
    await set(`studentViews/${ME}_${SUBJECT}`, { studentId: ME, subjectId: SUBJECT, days: { [TUESDAY]: "Absent" }, leaves: {}, corrections: {}, last: TUESDAY });
    await set(`studentViews/${CLASSMATE}_${SUBJECT}`, { studentId: CLASSMATE, subjectId: SUBJECT, days: { [TUESDAY]: "Present" }, last: TUESDAY });
  });
}

const as = uid => env.authenticatedContext(uid).firestore();
const attendance = (subjectId, date, records = { [ME]: "Present" }) =>
  ({ subjectId, date, records, markedBy: "T1", timestamp: 1, markedAt: "x" });
const dayView = (studentId, subjectId, date, status) =>
  ({ studentId, subjectId, days: { [date]: status }, last: date });

// ---------- Marking attendance ----------
test("teacher can mark their own class on a normal past weekday", async () => {
  await assertSucceeds(as("t1").doc(`attendance/${SUBJECT}_${MONDAY}`).set(attendance(SUBJECT, MONDAY)));
});

for (const [why, subjectId, date] of [
  ["on a Sunday", SUBJECT, SUNDAY],
  ["for a future date", SUBJECT, FUTURE],
  ["on a day the HOD closed", SUBJECT, "2026-10-21"],
  ["for a class marked not held", SUBJECT, "2026-10-22"],
  ["in a semester that is not ACTIVE", CLOSED_SUBJECT, MONDAY],
  ["for a subject they don't teach", OTHER_SUBJECT, MONDAY]
]) {
  test(`teacher cannot mark attendance ${why}`, async () => {
    await assertFails(as("t1").doc(`attendance/${subjectId}_${date}`).set(attendance(subjectId, date)));
  });
}

test("saved attendance cannot be changed or deleted", async () => {
  const ref = as("t1").doc(`attendance/${SUBJECT}_${TUESDAY}`);
  await assertFails(ref.set(attendance(SUBJECT, TUESDAY)));
  await assertFails(ref.delete());
});

// ---------- Teacher writes students' copies ----------
test("teacher saves a 60-student class and every student's copy in one batch", async () => {
  const db = as("t1");
  const records = Object.fromEntries(STUDENTS.map((s, i) => [s, i % 3 ? "Present" : "Absent"]));
  const b = db.batch();
  b.set(db.doc(`attendance/${SUBJECT}_${MONDAY}`), attendance(SUBJECT, MONDAY, records));
  STUDENTS.forEach(s => b.set(db.doc(`studentViews/${s}_${SUBJECT}`), dayView(s, SUBJECT, MONDAY, records[s]), { merge: true }));
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
    .set({ studentId: ME, subjectId: SUBJECT, corrections: { [TUESDAY]: "Present" }, last: TUESDAY }, { merge: true }));
});

test("teacher cannot write copies for a subject they don't teach", async () => {
  await assertFails(as("t2").doc(`studentViews/${ME}_${SUBJECT}`).set(dayView(ME, SUBJECT, TUESDAY, "Absent"), { merge: true }));
});

test("teacher can add a leave to a copy only if it matches the leave record", async () => {
  const ref = as("t1").doc(`studentViews/${ME}_${SUBJECT}`);
  await assertFails(ref.set({ studentId: ME, subjectId: SUBJECT, leaves: { [TUESDAY]: "CASUAL" }, last: TUESDAY }, { merge: true }));
  await assertSucceeds(ref.set({ studentId: ME, subjectId: SUBJECT, leaves: { [TUESDAY]: "MEDICAL" }, last: TUESDAY }, { merge: true }));
});

test("HOD can write any copy (approvals, rebuild)", async () => {
  await assertSucceeds(as("hod").doc(`studentViews/${ME}_${SUBJECT}`)
    .set({ studentId: ME, subjectId: SUBJECT, corrections: { [TUESDAY]: "Present" } }, { merge: true }));
});

// ---------- What a student can read ----------
test("student can read their own copies", async () => {
  const db = as("s1");
  await assertSucceeds(db.collection("studentViews").where("studentId", "==", ME).get());
  await assertSucceeds(db.doc(`studentViews/${ME}_${SUBJECT}`).get());
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
  await assertFails(db.collection("attendance").get());
  await assertFails(db.collection("leaves").get());
  await assertFails(db.collection("attendanceCorrections").get());
});

test("student cannot write their own copy", async () => {
  await assertFails(as("s1").doc(`studentViews/${ME}_${SUBJECT}`).set(dayView(ME, SUBJECT, TUESDAY, "Present"), { merge: true }));
});

test("student can still read class-level data for their dashboard", async () => {
  const db = as("s1");
  await assertSucceeds(db.collection("subjects").get());
  await assertSucceeds(db.collection("dayStatuses").get());
  await assertSucceeds(db.collection("classCancellations").get());
});

test("teacher can still read attendance, leaves and corrections", async () => {
  const db = as("t1");
  await assertSucceeds(db.collection("attendance").get());
  await assertSucceeds(db.collection("leaves").get());
  await assertSucceeds(db.collection("attendanceCorrections").get());
});

test("not logged in: no attendance and no copies", async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(db.collection("attendance").get());
  await assertFails(db.collection("studentViews").get());
});

test("leave can still be recorded after attendance is saved", async () => {
  // existing rule, checked so the new rules don't break it
  const db = as("t1");
  await assertSucceeds(db.doc(`leaves/${SUBJECT}_${TUESDAY}_${CLASSMATE}`).set({
    subjectId: SUBJECT, date: TUESDAY, studentId: CLASSMATE, type: "CASUAL", reference: "", markedBy: "T1", markedAt: "x"
  }));
});
