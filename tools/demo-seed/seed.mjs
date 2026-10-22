// =====================================================================
// Demo data: fills an EMPTY Firebase project with a sample institution,
// so the college can try the app (Principal, HODs, teachers, students)
// before deciding. Never run this on a project with real data — it
// refuses to.
//
//   1. Create a new Firebase project for the demo (free plan is fine),
//      enable Authentication -> Email/Password and create a Firestore
//      database. Deploy the app and rules to it.
//   2. Firebase console -> Project settings -> Service accounts ->
//      "Generate new private key". Keep that file private.
//   3. cd tools/demo-seed && npm install
//      node seed.mjs --key /path/to/key.json
//
// Every demo login uses the password printed at the end.
// =====================================================================
import admin from "firebase-admin";
import fs from "node:fs";

const REAL_PROJECTS = ["attendance-system-df860"];      // never touch these
const PASSWORD = "demo1234";
const EMAIL_DOMAIN = "users.attendance.example.com";

// ---------- connect ----------
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const keyFile = arg("--key");
const emulator = !!process.env.FIRESTORE_EMULATOR_HOST;
if (keyFile) {
  const key = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  admin.initializeApp({ credential: admin.credential.cert(key), projectId: key.project_id });
} else if (emulator && arg("--project")) {
  admin.initializeApp({ projectId: arg("--project") });
} else {
  console.error("Usage: node seed.mjs --key /path/to/service-account-key.json");
  process.exit(1);
}
const projectId = admin.app().options.projectId;
const db = admin.firestore();
const auth = admin.auth();

if (REAL_PROJECTS.includes(projectId)) {
  console.error(`Refusing: "${projectId}" is the real project. Use a separate project for the demo.`);
  process.exit(1);
}
for (const id of ["institution", "hod"]) {
  if ((await db.doc(`config/${id}`).get()).exists) {
    console.error(`Refusing: project "${projectId}" already has data (config/${id}). Use a new, empty project.`);
    process.exit(1);
  }
}
console.log(`Filling "${projectId}"${emulator ? " (emulator)" : ""} with demo data…`);

// ---------- small helpers ----------
let seed = 7;
const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };   // repeatable
const istToday = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const addDays = (date, n) => { const d = new Date(date + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isSunday = date => new Date(date + "T00:00:00Z").getUTCDay() === 0;
const now = new Date().toISOString();

const writes = [];
const put = (path, data) => writes.push({ path, data });
const logins = [];
async function login(loginId, role, name, profile) {
  const email = `${loginId.replace(/[^a-z0-9._-]/g, "")}.demo@${EMAIL_DOMAIN}`;
  const user = await auth.createUser({ email, password: PASSWORD });
  put(`users/${user.uid}`, { role, name, loginId, active: true, mustChangePassword: false, createdAt: now, ...profile });
  put(`loginNames/${loginId}`, { email, uid: user.uid, departmentId: profile.departmentId || "" });
  logins.push({ role, name, loginId, dept: profile.departmentId || "" });
  return user.uid;
}

// ---------- the institution ----------
const adminUid = await login("admin", "Admin", "Office Admin", {});
await login("principal", "Principal", "The Principal", {});
put("config/institution", { adminUid, name: "Demo College", createdAt: now });
put("config/settings", { casualLeaveLimit: 4 });

const DEPTS = [
  { id: "economics", name: "Economics", programs: ["UG"], rollBase: 25001, minorFor: "commerce",
    subjects: [["Microeconomics", "MAJOR"], ["Indian Economy", "CORE"], ["Economics for Everyone", "MINOR"]],
    teachers: ["Dr Asifa Bhat", "Mr Tariq Mir", "Ms Nida Shah"] },
  { id: "physics", name: "Physics", programs: ["UG", "PG"], rollBase: 26001, minorFor: "economics",
    subjects: [["Mechanics", "MAJOR"], ["Mathematical Physics", "CORE"], ["Physics for Economists", "MINOR"]],
    teachers: ["Dr Ravi Kaul", "Ms Saima Wani", "Mr Imran Dar"] },
  { id: "chemistry", name: "Chemistry", programs: ["UG"], rollBase: 27001, minorFor: "physics",
    subjects: [["Organic Chemistry", "MAJOR"], ["Physical Chemistry", "CORE"], ["Everyday Chemistry", "MINOR"]],
    teachers: ["Dr Mehraj Lone", "Ms Rubeena Khan", "Mr Faisal Qadri"] },
  { id: "commerce", name: "Commerce", programs: ["UG", "IG"], rollBase: 28001, minorFor: "chemistry",
    subjects: [["Financial Accounting", "MAJOR"], ["Business Law", "CORE"], ["Personal Finance", "MINOR"]],
    teachers: ["Dr Sameer Raina", "Ms Uzma Hamid", "Mr Owais Malik"] }
];
const FIRST = ["Aamir", "Bisma", "Danish", "Farah", "Gowhar", "Hina", "Irfan", "Javeed", "Kounsar", "Lateef",
               "Mehvish", "Nasir", "Omar", "Qurat", "Rafiq", "Sana", "Tabish", "Umar", "Waseem", "Yasmeen"];
const LAST = ["Bhat", "Dar", "Lone", "Mir", "Shah", "Wani", "Khan", "Malik", "Rather", "Sofi"];

const students = {};    // dept -> [student]
const subjects = [];    // { ...subject, teacherId, teacherName, enrolled: [student] }
let idCounter = 0;
const newId = () => 1760000000000 + (++idCounter) * 1000;

for (const d of DEPTS) {
  put(`departments/${d.id}`, { name: d.name, programs: d.programs, createdAt: now });
  await login(`hod.${d.id}`, "HOD", `HOD ${d.name}`, { departmentId: d.id });

  const batchId = newId();
  put(`batches/${batchId}_3`, { id: batchId, program: "UG", year: 2025, semester: "3", status: "ACTIVE", departmentId: d.id,
    statusHistory: [{ status: "ACTIVE", at: now, by: `hod.${d.id}` }] });

  const teacherIds = [];
  for (const [i, tName] of d.teachers.entries()) {
    const teacherId = `demo-${d.id}-t${i + 1}`;
    const loginId = `${d.id.slice(0, 4)}.t${i + 1}`;
    const uid = await login(loginId, "Teacher", tName, { teacherId, departmentId: d.id });
    put(`teachers/${teacherId}`, { id: teacherId, name: tName, username: loginId, loginId, uid, departmentId: d.id, status: "ACTIVE" });
    teacherIds.push({ teacherId, tName });
  }

  students[d.id] = [];
  for (let i = 0; i < 30; i++) {
    const id = newId() + 0.5;
    const roll = String(d.rollBase + i);
    const name = `${FIRST[(i + d.rollBase) % FIRST.length]} ${LAST[(i + Math.floor(i / FIRST.length) * 3 + d.rollBase) % LAST.length]}`;   // unique in the department
    const st = { id, name, roll, batchId, departmentId: d.id, status: "ACTIVE",
                 presence: i % 10 === 9 ? 0.55 : 0.8 + rand() * 0.18 };   // a few defaulters
    if (i < 5) {   // the first five students of each department have logins
      st.uid = await login(roll, "Student", name, { roll, studentId: id, studentDocId: String(id), departmentId: d.id });
      st.loginId = roll;
    }
    students[d.id].push(st);
  }

  d.subjects.forEach(([name, type], i) => {
    const id = newId();
    const t = teacherIds[i];
    subjects.push({ id, name, type, batchId, departmentId: d.id, program: "UG", semester: "3", year: 2025,
                    teacherId: t.teacherId, teacherName: t.tName, offeredTo: type === "MINOR" ? d.minorFor : d.id });
  });
}

// Enrollments: own students for Major/Core; 15 students of another department for the Minor
for (const s of subjects) {
  s.enrolled = s.type === "MINOR" ? students[s.offeredTo].slice(0, 15) : students[s.departmentId];
  const { enrolled, offeredTo, teacherName, ...subject } = s;
  delete subject.teacherId;
  put(`subjects/${s.id}`, subject);
  put(`subjectAssignments/${s.id}`, { subjectId: String(s.id), teacherId: s.teacherId, departmentId: s.departmentId,
    timestamp: now, history: [{ teacherId: s.teacherId, from: "2026-08-01", to: null }] });
  put(`enrollments/${s.id}`, { subjectId: String(s.id), students: s.enrolled.map(st => st.id), departmentId: s.departmentId });
}
for (const list of Object.values(students)) {
  for (const { presence, ...st } of list) put(`students/${st.id}`, st);
}

// ---------- three weeks of attendance ----------
const today = istToday();
const institutionClosed = addDays(today, -8);
const physicsClosed = addDays(today, -4);
put(`dayStatuses/${institutionClosed}`, { date: institutionClosed, type: "weather", reason: "Heavy snowfall", departmentId: "ALL", markedBy: "admin", timestamp: now });
put(`dayStatuses/physics_${physicsClosed}`, { date: physicsClosed, type: "event", reason: "Physics department seminar", departmentId: "physics", markedBy: "hod.physics", timestamp: now });

const views = {};   // "<studentId>_<subjectId>" -> copy
const view = (st, s) => {
  const key = `${st.id}_${s.id}`;
  return views[key] = views[key] || { studentId: String(st.id), subjectId: String(s.id), departmentId: s.departmentId, days: {}, leaves: {}, corrections: {} };
};
for (let back = 21; back >= 0; back--) {
  const date = addDays(today, -back);
  if (isSunday(date) || date === institutionClosed) continue;
  for (const s of subjects) {
    if (s.departmentId === "physics" && date === physicsClosed) continue;
    if (rand() < 0.25) continue;                                    // not every subject meets every day
    if (back === 0 && rand() < 0.4) continue;                       // some of today's classes not marked yet
    if (back > 0 && rand() < 0.04) {                                // occasionally a class is not held
      put(`classCancellations/${s.id}_${date}`, { subjectId: String(s.id), date, teacherId: s.teacherId, reason: "Teacher on duty elsewhere", departmentId: s.departmentId, timestamp: now });
      continue;
    }
    const records = {};
    let present = 0, leave = 0;
    const markedAt = new Date(`${date}T${String(3 + Math.floor(rand() * 6)).padStart(2, "0")}:${String(Math.floor(rand() * 60)).padStart(2, "0")}:00Z`).toISOString();
    for (const st of s.enrolled) {
      const here = rand() < st.presence;
      records[String(st.id)] = here ? "Present" : "Absent";
      view(st, s).days[date] = records[String(st.id)];
      if (here) { present++; continue; }
      if (rand() < 0.12) {                                          // some absences are leave
        const type = ["CASUAL", "MEDICAL", "NCC"][Math.floor(rand() * 3)];
        put(`leaves/${s.id}_${date}_${st.id}`, { subjectId: String(s.id), departmentId: s.departmentId, date, studentId: String(st.id),
          type, reference: type === "MEDICAL" ? "Medical certificate" : "", markedBy: s.teacherId, markedAt });
        view(st, s).leaves[date] = type;
        leave++;
      }
    }
    put(`attendance/${s.id}_${date}`, { subjectId: String(s.id), departmentId: s.departmentId, date, records,
      timestamp: Date.parse(markedAt), markedBy: s.teacherId, markedAt });
    put(`classSummaries/${s.id}_${date}`, { departmentId: s.departmentId, subjectId: String(s.id), date,
      subjectName: `${s.name} (${s.type} | UG Batch 2025 Sem 3)`, teacherId: s.teacherId, teacherName: s.teacherName,
      present, leave, absent: s.enrolled.length - present - leave, markedAt });
  }
}
for (const [key, v] of Object.entries(views)) put(`studentViews/${key}`, v);

// ---------- save ----------
for (let i = 0; i < writes.length; i += 450) {
  const batch = db.batch();
  writes.slice(i, i + 450).forEach(w => batch.set(db.doc(w.path), w.data));
  await batch.commit();
  process.stdout.write(`\rSaved ${Math.min(i + 450, writes.length)} of ${writes.length} records`);
}
console.log("\n\nDemo logins (password for all: " + PASSWORD + ")");
const show = r => console.log(`  ${r.role.padEnd(10)} ${r.loginId.padEnd(18)} ${r.name}${r.dept ? "  [" + r.dept + "]" : ""}`);
logins.filter(r => r.role !== "Student").forEach(show);
console.log("  Student    any of the first five roll numbers of each department, e.g. 25001, 26001, 27001, 28001");
console.log("\nMinors across departments: Economics students take Physics' Minor, Physics students take Chemistry's,");
console.log("Chemistry students take Commerce's, and Commerce students take Economics'.");
process.exit(0);
