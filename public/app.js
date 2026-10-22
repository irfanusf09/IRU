// ==========================
// Firebase Initialization
// ==========================

// Firebase settings live in firebase-config.js (loaded before this file)

// Initialize Firebase
firebase.initializeApp(firebaseConfig);

// (Firestore will be used later)
   const db = firebase.firestore();



// Firebase Authentication: passwords are checked by Google, never stored by us
const auth = firebase.auth();
const Auth = {};
// Internal sign-in addresses (no real mailbox; people only ever see their Login ID)
const ACCOUNT_EMAIL_DOMAIN = "users.attendance.example.com";

let idleTimer;
function resetIdleTimer() {
  clearTimeout(idleTimer);

  hideExpiryWarning(); // ✅ Always hide old warning

  // ⏰ Show warning BEFORE actual logout
  const warningTimer = setTimeout(() => {
    if (Auth.isLoggedIn()) {
      showExpiryWarning();
    }
  }, (15 * 60 * 1000) - (60 * 1000)); // 14 min → show warning

  idleTimer = setTimeout(() => {
    if (Auth.isLoggedIn()) {
      const app = document.getElementById("appContainer");
      if (app) app.style.display = "none";            // hide data immediately
      Auth.logout().finally(() =>
        UI.alert("Your session ended because of inactivity. Please log in again.", { title: "Session expired" })
          .then(() => location.reload()));
    }
  }, 15 * 60 * 1000);
}
     function showExpiryWarning() {
  let banner = document.getElementById("sessionWarning");

  if (!banner) {
    banner = document.createElement("div");
    banner.id = "sessionWarning";

    banner.style.position = "fixed";
    banner.style.bottom = "20px";
    banner.style.right = "20px";
    banner.style.background = "#fff3cd";
    banner.style.color = "#856404";
    banner.style.padding = "12px 18px";
    banner.style.border = "1px solid #ffeeba";
    banner.style.borderRadius = "6px";
    banner.style.boxShadow = "0 4px 10px rgba(0,0,0,0.15)";
    banner.style.zIndex = "9999";
    banner.style.fontSize = "14px";

    banner.innerHTML = "⏰ Session expiring in 60 seconds due to inactivity.";

    document.body.appendChild(banner);
  }

  banner.style.display = "block";
}

function hideExpiryWarning() {
  const banner = document.getElementById("sessionWarning");
  if (banner) banner.style.display = "none";
}

// ---------- Login IDs & passwords ----------
Auth.normalizeLoginId = v => String(v || "").trim().toLowerCase().replace(/\s+/g, "-");
Auth.isValidLoginId = id => /^[a-z0-9][a-z0-9._-]{0,40}[a-z0-9]$/.test(id);
Auth.makeEmail = function (loginId) {
  const local = loginId.replace(/[^a-z0-9._-]/g, "").replace(/\.+/g, ".").replace(/^\.|\.$/g, "") || "user";
  return `${local}.${Math.random().toString(36).slice(2, 8)}@${ACCOUNT_EMAIL_DOMAIN}`;
};
Auth.generatePassword = function (len = 8) {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";       // no look-alikes (0/o, 1/l)
  const arr = new Uint32Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, n => chars[n % chars.length]).join("");
};

// ---------- Session (a cached copy of the signed-in profile, for the screens) ----------
// Security does NOT depend on this cache: the database rules check the real
// Firebase login on every read and write.
Auth.currentUser = function () {
  try {
    return JSON.parse(localStorage.getItem("currentUser"));
  } catch (e) {
    localStorage.removeItem("currentUser");
    return null;
  }
};
Auth.isLoggedIn = function () { return !!Auth.currentUser(); };
Auth.logout = function () {
  localStorage.removeItem("currentUser");
  localStorage.removeItem("lastSection");
  Auth._lastPassword = null;
  return auth.signOut().catch(() => {});
};

Auth.profileToSessionUser = function (uid, p) {
  const base = { uid, role: p.role, name: p.name || "", loginId: p.loginId || "" };
  if (p.role === "HOD") return { ...base, username: p.loginId };
  if (p.role === "Teacher") return { ...base, id: String(p.teacherId), username: p.loginId };
  if (p.role === "Student") return { ...base, studentId: p.studentId, studentDocId: String(p.studentDocId), roll: p.roll || "" };
  return null;
};

Auth.loadProfile = async function (uid) {
  const snap = await db.collection("users").doc(uid).get();
  return snap.exists ? snap.data() : null;
};

// Returns { ok: true, user, mustChangePassword } or { ok: false, error }
Auth.isInternalEmail = e => String(e || "").toLowerCase().endsWith("@" + ACCOUNT_EMAIL_DOMAIN);

Auth.login = async function (loginIdRaw, password) {
  const raw = String(loginIdRaw || "").trim();
  if (!raw || !password) return { ok: false, error: "Enter your login ID and password." };
  const byEmail = raw.includes("@");      // people with a confirmed recovery email log in with it

  let email;
  if (byEmail) {
    email = raw.toLowerCase();
  } else {
    const loginId = Auth.normalizeLoginId(raw);
    try {
      const snap = await db.collection("loginNames").doc(loginId).get();
      if (!snap.exists) return { ok: false, error: "Login ID or password is incorrect." };
      email = snap.data().email;
    } catch (e) {
      console.error(e);
      return { ok: false, error: "Could not reach the server. Check your internet connection." };
    }
  }

  try {
    await auth.signInWithEmailAndPassword(email, password);
  } catch (e) {
    console.warn("Sign-in failed:", e.code);
    if (e.code === "auth/too-many-requests") return { ok: false, error: "Too many attempts. Wait a few minutes and try again." };
    if (e.code === "auth/network-request-failed") return { ok: false, error: "Could not reach the server. Check your internet connection." };
    return { ok: false, error: byEmail
      ? "Email or password is incorrect."
      : "Login ID or password is incorrect. (If you confirmed a recovery email, log in with that email instead.)" };
  }

  const uid = auth.currentUser.uid;
  let profile = null;
  try { profile = await Auth.loadProfile(uid); } catch (e) { console.error(e); }
  if (!profile || profile.active !== true) {
    await auth.signOut().catch(() => {});
    return { ok: false, error: profile ? "This account has been deactivated. Contact the HOD." : "This account is not set up yet. Contact the HOD." };
  }

  const user = Auth.profileToSessionUser(uid, profile);
  localStorage.setItem("currentUser", JSON.stringify(user));
  Auth._lastPassword = password;   // memory only, for the first-login password change
  return { ok: true, user, mustChangePassword: profile.mustChangePassword === true };
};

Auth.changePassword = async function (currentPassword, newPassword) {
  const u = auth.currentUser;
  if (!u) throw new Error("Not signed in");
  const cred = firebase.auth.EmailAuthProvider.credential(u.email, currentPassword);
  await u.reauthenticateWithCredential(cred);
  await u.updatePassword(newPassword);
  await db.collection("users").doc(u.uid).update({ mustChangePassword: false });
  Auth._lastPassword = null;
};

// ---------- One-time HOD setup ----------
Auth.isSetupDone = async function () {
  try {
    return (await db.collection("config").doc("hod").get()).exists;
  } catch (e) {
    console.warn(e);
    return true;   // if unsure, don't offer setup
  }
};

Auth.setupHod = async function (loginIdRaw, name, password) {
  const loginId = Auth.normalizeLoginId(loginIdRaw);
  if (await Auth.isSetupDone()) throw new Error("Setup has already been completed. Please log in.");
  const email = Auth.makeEmail(loginId);
  const cred = await auth.createUserWithEmailAndPassword(email, password);
  const uid = cred.user.uid;
  const now = new Date().toISOString();
  const profile = { role: "HOD", name, loginId, active: true, mustChangePassword: false, createdAt: now };
  try {
    const batch = db.batch();
    batch.set(db.collection("users").doc(uid), profile);
    batch.set(db.collection("config").doc("hod"), { uid, createdAt: now });
    batch.set(db.collection("loginNames").doc(loginId), { email, uid });
    await batch.commit();
  } catch (e) {
    await auth.signOut().catch(() => {});
    throw e;
  }
  localStorage.setItem("currentUser", JSON.stringify(Auth.profileToSessionUser(uid, profile)));
};

const App = {};
App.getTeachersFromFirestore = async function () {
  try {
    const snapshot = await db.collection("teachers").get();

    const teachers = [];

    snapshot.forEach(doc => {
      teachers.push(doc.data());
    });

    console.log("Loaded teachers from Firestore:", teachers);

    return teachers;

  } catch (e) {
    console.warn("Firestore unavailable, using LocalStorage");
    return [];
  }
};
// Saves the class's attendance together with each student's own copy (studentViews).
// Returns { ok, copiesMissing } — copiesMissing > 0 means the attendance is saved
// but some students won't see this day until the HOD runs "Rebuild".
App.saveAttendanceToFirestore = async function (record) {
  const ref = db.collection("attendance").doc(`${record.subjectId}_${record.date}`);
  const copies = Object.keys(record.records).map(studentId =>
    App.StudentViews.dayWrite(studentId, record.subjectId, record.date, record.records[studentId]));

  try {
    const batch = db.batch();
    batch.set(ref, record);
    copies.forEach(c => batch.set(c.ref, c.data, { merge: true }));
    await batch.commit();
    return { ok: true, copiesMissing: 0 };
  } catch (e) {
    console.warn("Saving attendance with student copies failed", e);
    if (!e || e.code !== "permission-denied") return { ok: false };
  }

  // Refused as a whole: save the attendance alone, then the copies one by one
  try {
    await ref.set(record);
  } catch (e) {
    console.warn("Firestore save failed", e);
    return { ok: false };
  }
  const results = await Promise.allSettled(copies.map(c => c.ref.set(c.data, { merge: true })));
  return { ok: true, copiesMissing: results.filter(r => r.status === "rejected").length };
};
App.addTeacherToFirestore = async function(teacher) {
  try {
    const docRef = db.collection("teachers").doc(); 
    
    const newTeacher = {
      id: String(docRef.id),          // 🔑 CRITICAL
      name: teacher.name,
      username: Auth.normalizeLoginId(teacher.username),
      status: "ACTIVE"                // passwords are NOT stored here (Firebase Auth keeps them)
    };

    await docRef.set(newTeacher);

    console.log("✅ Teacher saved:", newTeacher);
    return newTeacher;

  } catch (e) {
    console.error("❌ Teacher save failed:", e);
    return false;
  }
};

// ==========================
// Firestore Batch Helpers
// ==========================

// Load batches from Firestore


// Save a batch to Firestore
App.saveBatchToFirestore = async function(batch) {
  try {

    const docId = String(batch.id) + "_" + batch.semester;

    await db.collection("batches").doc(docId).set(batch);

    console.log("Batch saved to Firestore:", batch);

    return true;

  } catch (e) {
    console.error("Batch save failed:", e);
    return false;
  }
};

// ==========================
// Firestore Subject Helpers
// ==========================

// Load subjects from Firestore


// Save subject to Firestore
App.saveSubjectToFirestore = async function(subject) {
  try {

    const docId = String(subject.id);

    await db.collection("subjects").doc(docId).set(subject);

    console.log("Subject saved to Firestore:", subject);

    return true;

  } catch (e) {
    console.error("Subject save failed:", e);
    return false;
  }
};
App.deleteSubjectFromFirestore = async function(subjectId) {
  try {
    // Remove the subject together with its student list and teacher assignment
    const batch = db.batch();
    batch.delete(db.collection("subjects").doc(String(subjectId)));
    batch.delete(db.collection("enrollments").doc(String(subjectId)));
    batch.delete(db.collection("subjectAssignments").doc(String(subjectId)));
    await batch.commit();
    console.log("Subject deleted from Firestore:", subjectId);
    return true;
  } catch (e) {
    console.error("Subject delete failed:", e);
    return false;
  }
};
App.deleteStudentFromFirestore = async function(studentId) {
  try {
    await db.collection("students").doc(String(studentId)).delete();
    console.log("Student deleted from Firestore:", studentId);
    return true;
  } catch (e) {
    console.error("Student delete failed:", e);
    return false;
  }
};
App.deleteBatchFromFirestore = async function(batchId, semester) {
  try {
    const docId = `${batchId}_${semester}`;
    await db.collection("batches").doc(docId).delete();
    console.log("Batch deleted from Firestore:", docId);
    return true;
  } catch (e) {
    console.error("Batch delete failed:", e);
    return false;
  }
};
// ==========================
// Firestore Student Helpers
// ==========================

// Load students from Firestore


// Save student to Firestore
App.saveStudentToFirestore = async function(student) {
  try {

    const docId = String(student.id);

    await db.collection("students").doc(docId).set(student);

    console.log("Student saved to Firestore:", student);

    return true;

  } catch (e) {
    console.error("Student save failed:", e);
    return false;
  }
};

// ==========================
// Firestore Enrollment Helpers
// ==========================

App.saveEnrollmentsToFirestore = async function(subjectId, studentIds) {
  try {

    const docId = String(subjectId);

    await db.collection("enrollments").doc(docId).set({
      subjectId: subjectId,
      students: studentIds
    });

    console.log("Enrollments saved:", subjectId);

  } catch (e) {
    console.error("Enrollment save failed:", e);
  }
};



// ==========================
// Firestore Subject Assignment Helpers
// ==========================

// Save assignment
// Keeps a history: who taught the subject from when to when
App.todayLocal = () => new Date().toLocaleDateString("en-CA");

App._historyOf = function (data) {
  if (!data) return [];
  if (Array.isArray(data.history)) return data.history.map(h => ({ ...h }));
  // older records without history: start from what we know
  return data.teacherId ? [{ teacherId: String(data.teacherId), from: (data.timestamp || "").slice(0, 10) || null, to: null }] : [];
};

App.saveSubjectAssignmentToFirestore = async function(subjectId, teacherId) {
  try {
    const ref = db.collection("subjectAssignments").doc(String(subjectId));
    const snap = await ref.get();
    const old = snap.exists ? snap.data() : null;
    const history = App._historyOf(old);
    const today = App.todayLocal();
    const current = history.find(h => !h.to);
    if (!(current && String(current.teacherId) === String(teacherId))) {
      history.forEach(h => { if (!h.to) h.to = today; });
      history.push({ teacherId: String(teacherId), from: today, to: null });
    }
    await ref.set({
      subjectId: String(subjectId),
      teacherId: String(teacherId),
      timestamp: new Date().toISOString(),
      history
    });
    return true;
  } catch (e) {
    console.error("Assignment save failed:", e);
    UI.alert("Could not save the assignment. Check your internet connection and try again.");
    return false;
  }
};

// Load all assignments
App.getSubjectAssignmentsFromFirestore = async function() {
  try {
    const snapshot = await db.collection("subjectAssignments").get();
    const map = {};

    snapshot.forEach(doc => {
      const data = doc.data();
      if (data.teacherId) map[String(data.subjectId)] = String(data.teacherId);
    });

    return map;

 } catch (e) {
  console.error("Firestore assignment fetch failed", e);
  return {};
}
};

// ==========================
// Firestore Day Status Helpers
// ==========================

// Save a closed day
App.saveDayStatusToFirestore = async function(date, obj) {
  try {
    await db.collection("dayStatuses").doc(date).set(obj);
    console.log("Day status saved:", date);
    return true;
  } catch (e) {
    console.error("Day status save failed:", e);
    return false;
  }
};

// Get all closed days
App.getDayStatusesFromFirestore = async function() {
  try {
    const snapshot = await db.collection("dayStatuses").get();
    const map = {};

    snapshot.forEach(doc => {
      map[doc.id] = doc.data();
    });

    return map;

  } catch (e) {
    console.warn("Firestore unavailable, using local dayStatuses");
    return {};
  }
};

// ==========================
// Firestore Class Cancellation Helpers
// ==========================



 

App.getAttendanceIndex = async function () {
  try {
    const snapshot = await db.collection("attendance").get();

    const index = {};

    snapshot.forEach(doc => {
      const data = doc.data();
      const { subjectId, date, records } = data;

      const sid = String(subjectId);
    if (!index[sid]) index[sid] = {};
    const normalizedRecords = {};

    Object.keys(records || {}).forEach(k => {
    normalizedRecords[String(k)] = records[k];
    });

    index[sid][date] = normalizedRecords;
    });

    return index;

  } catch (e) {
    console.warn("Attendance index rebuild failed", e);
    return {};
  }
};

// ==========================
// Phase 1 helpers (Firestore only)
// ==========================

// All attendance for ONE subject: { "YYYY-MM-DD": { studentId: "Present"/"Absent" } }
// Uses the document ID prefix "<subjectId>_" so it works whether subjectId was
// saved as a number or a string.
// Full attendance documents for one subject: { "YYYY-MM-DD": { records, markedBy } }
App.getAttendanceDocsForSubject = async function (subjectId) {
  const prefix = String(subjectId) + "_";
  const result = {};
  const snapshot = await db.collection("attendance")
    .orderBy(firebase.firestore.FieldPath.documentId())
    .startAt(prefix)
    .endAt(prefix + "\uf8ff")
    .get();

  snapshot.forEach(doc => {
    const data = doc.data();
    const date = data.date || doc.id.slice(prefix.length);
    const normalized = {};
    Object.keys(data.records || {}).forEach(k => {
      normalized[String(k)] = data.records[k];
    });
    result[date] = { records: normalized, markedBy: data.markedBy ? String(data.markedBy) : "" };
  });
  return result;
};

App.getAttendanceForSubject = async function (subjectId) {
  const docs = await App.getAttendanceDocsForSubject(subjectId);
  const result = {};
  Object.keys(docs).forEach(d => { result[d] = docs[d].records; });
  return result;
};

// Remove a teacher's assignment for one subject
// Unassign (e.g. teacher deactivated): keep the history, close the current period
App.removeSubjectAssignmentFromFirestore = async function (subjectId) {
  const ref = db.collection("subjectAssignments").doc(String(subjectId));
  const snap = await ref.get();
  if (!snap.exists) return;
  const history = App._historyOf(snap.data());
  history.forEach(h => { if (!h.to) h.to = App.todayLocal(); });
  await ref.set({ subjectId: String(subjectId), teacherId: null, timestamp: new Date().toISOString(), history });
};

// { subjectId: [ {teacherId, from, to}, ... ] }
App.getAssignmentHistories = async function () {
  const snapshot = await db.collection("subjectAssignments").get();
  const out = {};
  snapshot.forEach(doc => { out[String(doc.data().subjectId || doc.id)] = App._historyOf(doc.data()); });
  return out;
};

// "Ms A (01/08/2026 – 15/10/2026), Mr B (16/10/2026 – present)" — only periods overlapping [from, to]
App.teacherHistoryText = function (history, teachers, from, to) {
  const fmt = d => d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : "?";
  const nameOf = id => {
    const t = teachers.find(x => String(x.id) === String(id));
    return t ? t.name + (t.status === "FORMER" ? " (Former Staff)" : "") : "Unknown teacher";
  };
  const parts = (history || [])
    .filter(h => (!to || !h.from || h.from <= to) && (!from || !h.to || h.to >= from))
    .map(h => `${nameOf(h.teacherId)} (${fmt(h.from)} – ${h.to ? fmt(h.to) : "present"})`);
  return parts.join(", ");
};

// Short initials for the "Marked by" row
App.initials = function (name) {
  const w = String(name || "").replace(/^(mr|mrs|ms|dr|prof)\.?\s+/i, "").trim().split(/\s+/).filter(Boolean);
  if (!w.length) return "?";
  return (w.length === 1 ? w[0].slice(0, 2) : w[0][0] + w[w.length - 1][0]).toUpperCase();
};

// ==========================
// Leave
//   Casual leave is limited per subject (HOD setting); Medical, NCC, Other are not.
//   A leave turns a recorded absence into "Leave": the day is left out of the total.
//   Leaves are separate permanent records (who / when / type / reference); only the HOD can remove one.
// ==========================
App.LEAVE_TYPES = { CASUAL: "Casual", MEDICAL: "Medical", NCC: "NCC", OTHER: "Other" };
App.DEFAULT_CASUAL_LIMIT = 4;

App.getLeaveLimit = async function () {
  const now = Date.now();
  if (App._leaveLimitCache && now - App._leaveLimitCache.at < 60000) return App._leaveLimitCache.value;
  let value = App.DEFAULT_CASUAL_LIMIT;
  try {
    const snap = await db.collection("config").doc("settings").get();
    const v = snap.exists ? Number(snap.data().casualLeaveLimit) : NaN;
    if (Number.isFinite(v) && v >= 0) value = v;
  } catch (e) { console.warn("settings read failed", e); }
  App._leaveLimitCache = { at: now, value };
  return value;
};

App.saveLeaveLimit = async function (n) {
  await db.collection("config").doc("settings").set({ casualLeaveLimit: n }, { merge: true });
  App._leaveLimitCache = null;
};

// Ask the teacher for leave type (+ optional reference). Returns {type, reference} or null.
App.askLeaveDetails = async function (studentName, casualUsed, limit) {
  const casualLeft = Math.max(0, limit - casualUsed);
  const type = await UI.choose(`Leave type for ${studentName}:`, [
    { label: `Casual (${casualUsed} of ${limit} used in this subject)`, value: "CASUAL" },
    { label: "Medical", value: "MEDICAL" },
    { label: "NCC", value: "NCC" },
    { label: "Other", value: "OTHER" }
  ], { title: "Mark leave" });
  if (!type) return null;
  if (type === "CASUAL" && casualLeft <= 0) {
    await UI.alert(`${studentName} has already used all ${limit} casual leaves in this subject this semester.\n\n` +
      `This day can only be marked Absent — unless it is Medical, NCC or Other leave.`, { title: "Casual leave limit reached" });
    return null;
  }
  const ref = await UI.prompt("Leave form / reference number (optional):", { title: "Mark leave", placeholder: "e.g. HOD approval no. 12" });
  if (ref === null) return null;
  return { type, reference: String(ref).trim().slice(0, 100) };
};

App.leaveDocId = (subjectId, date, studentId) => `${subjectId}_${date}_${studentId}`;

App.saveLeave = async function ({ subjectId, date, studentId, type, reference }) {
  const user = Auth.currentUser() || {};
  const data = {
    subjectId: String(subjectId), date, studentId: String(studentId), type,
    reference: reference || "", markedBy: String(user.id || ""), markedAt: new Date().toISOString()
  };
  await db.collection("leaves").doc(App.leaveDocId(data.subjectId, date, data.studentId)).set(data);
  // The leave itself is saved; a missing copy is repaired by the HOD's "Rebuild"
  await App.StudentViews.ref(data.studentId, data.subjectId)
    .set({ studentId: data.studentId, subjectId: data.subjectId, leaves: { [date]: type }, last: date }, { merge: true })
    .catch(e => console.warn("Student copy of leave not saved", e));
};

// ==========================
// Students' own attendance copies (collection "studentViews")
//   Students may not read class-wide attendance, so each student has one
//   document per subject with only their own entries:
//   { studentId, subjectId, days: {date: status}, leaves: {date: type},
//     corrections: {date: correctedStatus}, last }
//   Teachers write days/leaves as they save; the HOD writes corrections and
//   can rebuild every copy from the original records.
// ==========================
App.StudentViews = {};

App.StudentViews.ref = (studentId, subjectId) =>
  db.collection("studentViews").doc(`${studentId}_${subjectId}`);

App.StudentViews.dayWrite = (studentId, subjectId, date, status) => ({
  ref: App.StudentViews.ref(studentId, subjectId),
  data: { studentId: String(studentId), subjectId: String(subjectId), days: { [date]: status }, last: date }
});

// The logged-in student's copies, { subjectId: copy }, cached for 20 seconds
App.StudentViews.mine = async function () {
  const now = Date.now();
  if (App._viewsCache && now - App._viewsCache.at < 20000) return App._viewsCache.map;
  const user = Auth.currentUser() || {};
  const snap = await db.collection("studentViews").where("studentId", "==", String(user.studentDocId)).get();
  const map = {};
  snap.forEach(doc => { map[String(doc.data().subjectId)] = doc.data(); });
  App._viewsCache = { at: now, map };
  return map;
};

App.StudentViews.setCorrection = function (studentId, subjectId, date, status) {
  return App.StudentViews.ref(studentId, subjectId)
    .set({ studentId: String(studentId), subjectId: String(subjectId), corrections: { [date]: status } }, { merge: true });
};

App.StudentViews.removeLeave = function (studentId, subjectId, date) {
  return App.StudentViews.ref(studentId, subjectId)
    .update(new firebase.firestore.FieldPath("leaves", date), firebase.firestore.FieldValue.delete());
};

// HOD: recreate every copy from attendance, approved corrections and leaves
App.StudentViews.rebuild = async function (onProgress) {
  const read = async c => { const out = []; (await db.collection(c).get()).forEach(d => out.push(d.data())); return out; };
  if (onProgress) onProgress("Reading attendance…");
  const [attendance, corrections, leaves] = await Promise.all([read("attendance"), read("attendanceCorrections"), read("leaves")]);

  const views = {};
  const view = (studentId, subjectId) => {
    const id = `${studentId}_${subjectId}`;
    return views[id] = views[id] ||
      { studentId: String(studentId), subjectId: String(subjectId), days: {}, leaves: {}, corrections: {} };
  };
  attendance.forEach(a => Object.entries(a.records || {}).forEach(([sid, status]) => {
    view(sid, a.subjectId).days[a.date] = status;
  }));
  // Same rule as the attendance engine: approved corrections only, latest wins
  corrections
    .filter(c => c.decision !== "Rejected" && App.normalizeStatus(c.correctedStatus))
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .forEach(c => { view(c.studentId, c.subjectId).corrections[c.date] = c.correctedStatus; });
  leaves.forEach(l => { view(l.studentId, l.subjectId).leaves[l.date] = l.type; });

  const writes = Object.entries(views).map(([id, data]) => ({ collection: "studentViews", id, data }));
  if (onProgress) onProgress(`Saving ${writes.length} student copies…`);
  await App.commitWrites(writes);
  App._viewsCache = null;
  return writes.length;
};

App.StudentViews.initRebuildButton = function () {
  const btn = document.getElementById("rebuildViewsBtn");
  const status = document.getElementById("rebuildViewsStatus");
  if (!btn || !status) return;
  btn.onclick = async () => {
    btn.disabled = true;
    status.style.color = "#555";
    try {
      const n = await App.StudentViews.rebuild(text => { status.textContent = text; });
      status.style.color = "green";
      status.textContent = `✅ Rebuilt ${n} student attendance copies.`;
    } catch (e) {
      console.error(e);
      status.style.color = "red";
      status.textContent = "Rebuild FAILED: " + App.Accounts.errorText(e);
    } finally {
      btn.disabled = false;
    }
  };
};

// All class cancellations, as a list
App.getAllClassCancellations = async function () {
  const snapshot = await db.collection("classCancellations").get();
  const list = [];
  snapshot.forEach(doc => list.push(doc.data()));
  return list;
};

// Save many documents safely (Firestore allows max 500 writes per batch)
App.commitWrites = async function (writes) {
  // writes: [{ collection, id, data }]
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    writes.slice(i, i + 400).forEach(w => {
      batch.set(db.collection(w.collection).doc(String(w.id)), w.data);
    });
    await batch.commit();
  }
};

// ==========================
// Attendance Engine — the ONE place attendance is calculated
// (Summary, Register, Defaulters, Archive and Student Dashboard all use it)
// ==========================

// "P", "present", "Present " -> "Present";  "A", "AB", "absent" -> "Absent"
App.normalizeStatus = function (s) {
  const v = String(s == null ? "" : s).trim().toLowerCase();
  if (v === "p" || v === "present") return "Present";
  if (v === "a" || v === "ab" || v === "absent") return "Absent";
  return null;
};

// All documents in a collection whose ID starts with prefix (e.g. "<subjectId>_")
App._getDocsByIdPrefix = async function (collection, prefix) {
  const snapshot = await db.collection(collection)
    .orderBy(firebase.firestore.FieldPath.documentId())
    .startAt(prefix)
    .endAt(prefix + "")
    .get();
  const out = [];
  snapshot.forEach(doc => out.push({ id: doc.id, data: doc.data() }));
  return out;
};

// Inclusive list of "YYYY-MM-DD" dates (timezone-safe)
App.datesBetween = function (from, to) {
  const [y1, m1, d1] = from.split("-").map(Number);
  const [y2, m2, d2] = to.split("-").map(Number);
  const out = [];
  for (let t = Date.UTC(y1, m1 - 1, d1); t <= Date.UTC(y2, m2 - 1, d2); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
};

App.isSundayDate = function (date) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() === 0;
};

// Approved corrections, cached for 20 seconds so one report doesn't re-read them
App._getCorrectionsCached = async function () {
  const now = Date.now();
  if (!App._corrCache || now - App._corrCache.at > 20000) {
    App._corrCache = { at: now, list: await App.getAttendanceCorrections() };
  }
  return App._corrCache.list;
};
App.clearAttendanceCaches = function () {
  App._corrCache = null;
  App._viewsCache = null;
  App._attendanceCache = {};
};

// Load everything needed to calculate one subject's attendance (4 small reads).
// A student may only read their own copy, so for them the same picture is
// built from it (see App.StudentViews).
App.loadSubjectData = async function (subjectId) {
  const sid = String(subjectId);
  const user = Auth.currentUser() || {};
  if (user.role === "Student") return App._loadOwnSubjectData(sid, String(user.studentDocId));

  const [attDocs, dayStatuses, cancelDocs, allCorrections, leaveDocs] = await Promise.all([
    App.getAttendanceDocsForSubject(sid),
    App.getDayStatuses(),
    App._getDocsByIdPrefix("classCancellations", sid + "_"),
    App._getCorrectionsCached(),
    App._getDocsByIdPrefix("leaves", sid + "_")
  ]);
  const byDate = {}, markedByDate = {};
  Object.keys(attDocs).forEach(d => { byDate[d] = attDocs[d].records; markedByDate[d] = attDocs[d].markedBy; });
  return App._subjectModel(sid, byDate, markedByDate, dayStatuses, cancelDocs, allCorrections, leaveDocs.map(x => x.data));
};

App._loadOwnSubjectData = async function (sid, me) {
  const [views, dayStatuses, cancelDocs] = await Promise.all([
    App.StudentViews.mine(),
    App.getDayStatuses(),
    App._getDocsByIdPrefix("classCancellations", sid + "_")
  ]);
  const v = views[sid] || {};
  const byDate = {};
  Object.entries(v.days || {}).forEach(([date, status]) => { byDate[date] = { [me]: status }; });
  const corrections = Object.entries(v.corrections || {}).map(([date, correctedStatus]) =>
    ({ subjectId: sid, date, studentId: me, correctedStatus, decision: "Approved", timestamp: 0 }));
  const leaves = Object.entries(v.leaves || {}).map(([date, type]) => ({ date, studentId: me, type }));
  return App._subjectModel(sid, byDate, {}, dayStatuses, cancelDocs, corrections, leaves);
};

App._subjectModel = function (sid, byDate, markedByDate, dayStatuses, cancelDocs, allCorrections, leaveList) {
  const leaves = {};
  leaveList.forEach(l => { leaves[l.date + "|" + String(l.studentId)] = l; });

  const cancelled = {};
  cancelDocs.forEach(d => {
    cancelled[d.data.date || d.id.slice(sid.length + 1)] = d.data;
  });

  // Only APPROVED corrections change attendance; latest approval wins
  const corr = {};
  allCorrections
    .filter(c => String(c.subjectId) === sid &&
                 c.decision !== "Rejected" &&
                 App.normalizeStatus(c.correctedStatus))
    .forEach(c => {
      const k = c.date + "|" + String(c.studentId);
      (corr[k] = corr[k] || []).push(c);
    });
  Object.values(corr).forEach(list =>
    list.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)));

  return {
    subjectId: sid,
    byDate,
    closedReason(date) {
      if (App.isSundayDate(date)) return { type: "sunday", reason: "Sunday" };
      return dayStatuses[date] || null;
    },
    isCancelled(date) { return !!cancelled[date]; },
    // Dates on which this class was actually held and marked
    heldDates(from, to) {
      return Object.keys(byDate)
        .filter(d => (!from || d >= from) && (!to || d <= to))
        .filter(d => !this.closedReason(d) && !this.isCancelled(d))
        .sort();
    },
    isCorrected(date, studentId) {
      return !!corr[date + "|" + String(studentId)];
    },
    effective(date, studentId) {
      if (this.closedReason(date) || this.isCancelled(date)) return null;
      const orig = (byDate[date] || {})[String(studentId)];
      if (orig === undefined || orig === null) return null;
      const list = corr[date + "|" + String(studentId)];
      const v = list ? App.normalizeStatus(list[list.length - 1].correctedStatus) : App.normalizeStatus(orig);
      // An approved leave turns a recorded absence into Leave (left out of the total)
      if (v === "Absent" && leaves[date + "|" + String(studentId)]) return "Leave";
      return v;
    },
    leaveOf(date, studentId) { return leaves[date + "|" + String(studentId)] || null; },
    markedBy(date) { return markedByDate[date] || ""; },
    casualUsed(studentId) {
      return Object.values(leaves).filter(l => String(l.studentId) === String(studentId) && l.type === "CASUAL").length;
    },
    recordedStudentIds() {
      const ids = new Set();
      Object.values(byDate).forEach(r => Object.keys(r).forEach(k => ids.add(String(k))));
      return [...ids];
    },
    tally(studentId, from, to) {
      let present = 0, absent = 0, leave = 0;
      for (const d of this.heldDates(from, to)) {
        const st = this.effective(d, studentId);
        if (st === "Present") present++;
        else if (st === "Absent") absent++;
        else if (st === "Leave") leave++;
      }
      const total = present + absent;          // leave days are left out of the total
      return { present, absent, leave, total, percent: total ? Math.round((present / total) * 100) : null };
    }
  };
};

// Subjects the logged-in user may see in report dropdowns
App.getVisibleSubjects = async function () {
  const user = Auth.currentUser();
  if (!user) return [];
  const subjects = await App.getSubjects();
  let list = subjects;
  if (user.role === "Teacher") {
    const map = await App.getSubjectAssignmentsFromFirestore();
    list = subjects.filter(s => String(map[String(s.id)]) === String(user.id));
  } else if (user.role === "Student") {
    const enr = await App.getEnrollments();
    const me = String(user.studentId);
    list = subjects.filter(s => (enr[String(s.id)] || []).map(String).includes(me));
  }
  // Newest batch first, then semester, then name
  return list.sort((a, b) =>
    (Number(b.year) - Number(a.year)) ||
    (Number(a.semester) - Number(b.semester)) ||
    String(a.name).localeCompare(String(b.name)));
};

App.subjectLabel = function (sub, batches) {
  const batch = batches.find(b => String(b.id) === String(sub.batchId) &&
                                  String(b.semester) === String(sub.semester));
  const program = batch ? batch.program : sub.program;
  const year = batch ? batch.year : sub.year;
  return `${sub.name} — ${program} Sem ${sub.semester} (Batch ${year}) [${sub.type}]`;
};

App.fillSubjectSelect = async function (select, { includeAll = true } = {}) {
  const subjects = await App.getVisibleSubjects();
  const batches = await App.getBatches();
  select.innerHTML = "";
  if (includeAll) {
    const o = document.createElement("option");
    o.value = "all";
    o.textContent = subjects.length ? "All my subjects" : "No subjects available";
    select.appendChild(o);
  }
  subjects.forEach(sub => {
    const o = document.createElement("option");
    o.value = sub.id;
    o.textContent = App.subjectLabel(sub, batches);
    select.appendChild(o);
  });
  return subjects;
};

App.sortByRoll = (a, b) =>
  String(a.roll).localeCompare(String(b.roll), undefined, { numeric: true });

// Escape text before putting it into HTML (names come from Excel uploads)
App.esc = function (v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
};

// ==========================
// Enrollment Sync Rules — the ONE place that decides which subjects share students
//   UG / IG : MAJOR, MINOR and CORE subjects of a batch share their list (per type);
//             MD, Skill, Elective, Other are managed subject by subject.
//   PG      : ALL subjects of the batch share one list.
//   Adding a student copies them into the chosen subject's semester and LATER
//   semesters only — never back into earlier (finished) semesters.
// ==========================
App.SYNCED_TYPES = ["MAJOR", "CORE", "MINOR"];

App.programOf = function (sub, batches) {
  if (sub.program) return sub.program;
  const b = (batches || []).find(b => String(b.id) === String(sub.batchId));
  return b ? b.program : "";
};

// All subjects (any semester) that share a student list with `sub`
App.syncGroup = function (sub, allSubjects, batches) {
  const sameBatch = allSubjects.filter(s => String(s.batchId) === String(sub.batchId));
  if (App.programOf(sub, batches) === "PG") return sameBatch;
  if (!App.SYNCED_TYPES.includes(sub.type)) return [sub];
  return sameBatch.filter(s => s.type === sub.type);
};

// Subjects a newly added student should join: the group, from this semester onward
App.syncTerritory = function (sub, allSubjects, batches) {
  const group = App.syncGroup(sub, allSubjects, batches)
    .filter(s => Number(s.semester) >= Number(sub.semester));
  if (!group.some(s => String(s.id) === String(sub.id))) group.push(sub);
  return group;
};

// ==========================
// Account Management (HOD) — creates Firebase logins without logging the HOD out
// ==========================
App.Accounts = {};

App.Accounts._creatorAuth = async function () {
  let app = firebase.apps.find(a => a.name === "accountCreator");
  if (!app) app = firebase.initializeApp(firebaseConfig, "accountCreator");
  const a = app.auth();
  try { await a.setPersistence(firebase.auth.Auth.Persistence.NONE); } catch (e) {}
  return a;
};

App.Accounts.errorText = function (e) {
  const code = (e && e.code) || "";
  if (code === "auth/too-many-requests" || code === "auth/quota-exceeded")
    return "Firebase is limiting new accounts from this network for now. Wait about an hour and try again — it continues where it stopped.";
  if (code === "auth/network-request-failed" || code === "unavailable")
    return "Could not reach the server. Check your internet connection.";
  if (code === "auth/weak-password") return "Password must be at least 6 characters.";
  if (code === "permission-denied") return "Permission denied. Are you logged in as HOD?";
  return (e && e.message) || "Something went wrong.";
};

App.Accounts.loginIdOwner = async function (loginId) {
  const snap = await db.collection("loginNames").doc(loginId).get();
  return snap.exists ? snap.data().uid : null;
};

// Create (or replace) a person's login.
// owner: { collection: "teachers"|"students", id, data } — that record gets loginId + uid.
App.Accounts.issueLogin = async function ({ loginId, password, profile, oldUid, owner }) {
  const creator = await App.Accounts._creatorAuth();
  const email = Auth.makeEmail(loginId);
  const cred = await creator.createUserWithEmailAndPassword(email, password);
  const uid = cred.user.uid;
  await creator.signOut().catch(() => {});

  const batch = db.batch();
  batch.set(db.collection("users").doc(uid), {
    ...profile, loginId, active: true, mustChangePassword: true, createdAt: new Date().toISOString()
  });
  batch.set(db.collection("loginNames").doc(loginId), { email, uid });
  if (oldUid && oldUid !== uid) batch.delete(db.collection("users").doc(oldUid));   // old password stops working
  if (owner) {
    const data = { ...owner.data, loginId, uid };
    delete data.password;
    batch.set(db.collection(owner.collection).doc(String(owner.id)), data);
  }
  await batch.commit();
  return { uid, email };
};

App.Accounts.removeLogin = async function (uid, loginId) {
  const batch = db.batch();
  if (uid) batch.delete(db.collection("users").doc(uid));
  if (loginId) batch.delete(db.collection("loginNames").doc(loginId));
  await batch.commit();
};

App.Accounts.setActive = async function (uid, active) {
  if (!uid) return;
  await db.collection("users").doc(uid).update({ active });
};

// ---------- Teachers ----------
App.Accounts.teacherLoginDialog = async function (t) {
  const loginId = Auth.normalizeLoginId(t.loginId || t.username);
  if (!Auth.isValidLoginId(loginId)) {
    UI.alert(`"${t.username}" can't be used as a login ID. Use letters, numbers, dots or dashes only.`);
    return;
  }
  if (!t.uid) {
    const owner = await App.Accounts.loginIdOwner(loginId);
    if (owner) { UI.alert(`Login ID "${loginId}" is already used by another account.`); return; }
  }
  if (t.uid && !(await App.Recovery.confirmHodReset(t.uid, t.name))) return;
  const typed = await UI.prompt(
    `${t.uid ? "NEW" : "Starting"} password for ${t.name} (at least 6 characters).\n` +
    `Leave empty to generate one automatically.`);
  if (typed === null) return;
  const password = typed.trim() || Auth.generatePassword();
  if (password.length < 6) { UI.alert("Password must be at least 6 characters."); return; }

  try {
    await App.Accounts.issueLogin({
      loginId, password,
      profile: { role: "Teacher", name: t.name, teacherId: String(t.id) },
      oldUid: t.uid,
      owner: { collection: "teachers", id: t.id, data: t }
    });
    UI.alert(`Login ready for ${t.name}\n\nLogin ID: ${loginId}\nPassword: ${password}\n\n` +
          `Give these to the teacher. They will choose their own password at first login.`);
  } catch (e) {
    console.error(e);
    UI.alert(App.Accounts.errorText(e));
  }
  if (typeof renderTeachers === "function") await renderTeachers();
};

// ---------- Students ----------
App.Accounts.studentLoginId = function (st, batch) {
  const roll = String(st.roll || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return Auth.normalizeLoginId(`${batch.program}${batch.year}-${roll}`);
};

App.Accounts.loadStudentLoginBatches = async function () {
  const select = document.getElementById("studentLoginBatchSelect");
  if (!select) return;
  const batches = await App.getBatches();
  const seen = new Set();
  select.innerHTML = "";
  batches
    .filter(b => b.status !== "ARCHIVED")
    .sort((a, b) => Number(b.year) - Number(a.year) || String(a.program).localeCompare(String(b.program)))
    .forEach(b => {
      if (seen.has(String(b.id))) return;
      seen.add(String(b.id));
      const o = document.createElement("option");
      o.value = String(b.id);
      o.textContent = `${b.program} Batch ${b.year}`;
      select.appendChild(o);
    });
};

App.Accounts._batchInfo = async function (batchId) {
  const batches = await App.getBatches();
  return batches.find(b => String(b.id) === String(batchId)) || null;
};

App.Accounts.renderStudentLogins = async function () {
  const out = document.getElementById("studentLoginsOutput");
  const batchId = document.getElementById("studentLoginBatchSelect").value;
  if (!out || !batchId) return;
  out.innerHTML = "<p>Loading…</p>";
  const batch = await App.Accounts._batchInfo(batchId);
  const students = (await App.getStudents())
    .filter(s => String(s.batchId) === String(batchId))
    .sort(App.sortByRoll);
  if (!students.length) { out.innerHTML = "<p>No students in this batch yet.</p>"; return; }

  const withLogin = students.filter(s => s.uid).length;
  let html = `<p><b>${withLogin}</b> of <b>${students.length}</b> students have a login.</p>
    <table border="1" cellpadding="5" width="100%" style="border-collapse:collapse;">
    <tr><th>Roll</th><th>Name</th><th>Login ID</th><th>Status</th><th></th></tr>`;
  students.forEach(st => {
    const id = st.loginId || App.Accounts.studentLoginId(st, batch);
    html += `<tr>
      <td>${App.esc(st.roll)}</td>
      <td style="text-align:left;">${App.esc(st.name)}</td>
      <td>${st.uid ? App.esc(id) : "<i style='color:#888'>" + App.esc(id) + "</i>"}</td>
      <td>${st.uid ? "✅ Has login" : "No login yet"}${st.status && st.status !== "ACTIVE" ? " (" + App.esc(st.status) + ")" : ""}</td>
      <td>${st.uid ? `<button data-reset="${App.esc(String(st.id))}">Reset password</button>` : ""}</td>
    </tr>`;
  });
  html += "</table>";
  out.innerHTML = html;
  out.querySelectorAll("button[data-reset]").forEach(btn => {
    btn.onclick = () => App.Accounts.resetStudent(btn.getAttribute("data-reset"));
  });
};

App.Accounts.createStudentLogins = async function () {
  const batchId = document.getElementById("studentLoginBatchSelect").value;
  const out = document.getElementById("studentLoginsOutput");
  const btn = document.getElementById("createStudentLoginsBtn");
  if (!batchId) { UI.alert("Select a batch first"); return; }
  const batch = await App.Accounts._batchInfo(batchId);
  const pending = (await App.getStudents())
    .filter(s => String(s.batchId) === String(batchId) && !s.uid && (!s.status || s.status === "ACTIVE"))
    .sort(App.sortByRoll);
  if (!pending.length) { UI.alert("Every active student in this batch already has a login."); return; }
  if (!await UI.confirm(`Create logins for ${pending.length} student(s) of ${batch.program} Batch ${batch.year}?\n\n` +
               `Each gets a random starting password, shown ONCE on the next screen. ` +
               `Download or print the list before leaving that screen.`)) return;

  btn.disabled = true;
  const created = [], problems = [];
  for (let i = 0; i < pending.length; i++) {
    const st = pending[i];
    out.innerHTML = `<p>Creating logins… ${i + 1} of ${pending.length}</p>`;
    const loginId = App.Accounts.studentLoginId(st, batch);
    try {
      if (!Auth.isValidLoginId(loginId)) { problems.push(`${st.roll} ${st.name}: roll number can't form a login ID`); continue; }
      if (await App.Accounts.loginIdOwner(loginId)) { problems.push(`${st.roll} ${st.name}: login ID ${loginId} already in use`); continue; }
      const password = Auth.generatePassword();
      await App.Accounts.issueLogin({
        loginId, password,
        profile: { role: "Student", name: st.name, roll: String(st.roll), studentId: st.id, studentDocId: String(st.id) },
        owner: { collection: "students", id: st.id, data: st }
      });
      created.push({ Roll: String(st.roll), Name: st.name, "Login ID": loginId, Password: password });
    } catch (e) {
      console.error(e);
      problems.push(`${st.roll} ${st.name}: ${App.Accounts.errorText(e)}`);
      if (e && (e.code === "auth/too-many-requests" || e.code === "auth/quota-exceeded")) break;
    }
  }
  btn.disabled = false;
  App.Accounts.showNewPasswords(created, problems, `${batch.program} Batch ${batch.year}`);
};

App.Accounts.resetStudent = async function (studentId) {
  const st = (await App.getStudents()).find(s => String(s.id) === String(studentId));
  if (!st) return;
  if (!(await App.Recovery.confirmHodReset(st.uid, st.name))) return;
  if (!await UI.confirm(`Give ${st.name} a NEW password? Their old password will stop working.`)) return;
  const batch = await App.Accounts._batchInfo(st.batchId);
  const loginId = st.loginId || App.Accounts.studentLoginId(st, batch);
  const password = Auth.generatePassword();
  try {
    await App.Accounts.issueLogin({
      loginId, password,
      profile: { role: "Student", name: st.name, roll: String(st.roll), studentId: st.id, studentDocId: String(st.id) },
      oldUid: st.uid,
      owner: { collection: "students", id: st.id, data: st }
    });
    App.Accounts.showNewPasswords([{ Roll: String(st.roll), Name: st.name, "Login ID": loginId, Password: password }], [],
      `${batch.program} Batch ${batch.year}`);
  } catch (e) {
    console.error(e);
    UI.alert(App.Accounts.errorText(e));
  }
};

App.Accounts.showNewPasswords = function (rows, problems, title) {
  const out = document.getElementById("studentLoginsOutput");
  let html = "";
  if (rows.length) {
    html += `<div style="padding:10px; background:#fff7ed; border:1px solid #fed7aa; margin-bottom:10px;">
      <b>⚠️ These passwords are shown only now.</b> Download or print them before leaving this screen.
      Students will choose their own password at first login.</div>
      <button id="downloadSlipsBtn" class="primary">Download as Excel</button>
      <button id="printSlipsBtn">Print login slips</button>
      <button id="doneSlipsBtn">Done</button>
      <table border="1" cellpadding="5" width="100%" style="border-collapse:collapse; margin-top:10px;">
      <tr><th>Roll</th><th>Name</th><th>Login ID</th><th>Starting password</th></tr>`;
    rows.forEach(r => {
      html += `<tr><td>${App.esc(r.Roll)}</td><td style="text-align:left;">${App.esc(r.Name)}</td>
               <td><b>${App.esc(r["Login ID"])}</b></td><td><b>${App.esc(r.Password)}</b></td></tr>`;
    });
    html += "</table>";
  } else {
    html += "<p>No new logins were created.</p>";
  }
  if (problems.length) {
    html += `<p style="color:#b45309; margin-top:10px;"><b>Not done:</b></p><ul>` +
            problems.map(p => `<li style="display:list-item;">${App.esc(p)}</li>`).join("") + "</ul>";
  }
  out.innerHTML = html;

  const dl = document.getElementById("downloadSlipsBtn");
  if (dl) dl.onclick = () => {
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Logins");
    XLSX.writeFile(wb, `Student_logins_${title.replace(/\s+/g, "_")}.xlsx`);
  };
  const pr = document.getElementById("printSlipsBtn");
  if (pr) pr.onclick = () => App.Accounts.printSlips(rows, title);
  const done = document.getElementById("doneSlipsBtn");
  if (done) done.onclick = async () => {
    if (await UI.confirm("Have you downloaded or printed the passwords? They cannot be shown again.")) {
      App.Accounts.renderStudentLogins();
    }
  };
};

App.Accounts.printSlips = function (rows, title) {
  const site = location.origin;
  const slips = rows.map(r => `
    <div class="slip">
      <div class="h">Department Attendance — Student Login</div>
      <div>${App.esc(r.Name)} (Roll ${App.esc(r.Roll)}) — ${App.esc(title)}</div>
      <div>Website: <b>${App.esc(site)}</b></div>
      <div>Login ID: <b>${App.esc(r["Login ID"])}</b></div>
      <div>Starting password: <b>${App.esc(r.Password)}</b></div>
      <div class="n">You will be asked to choose your own password at first login. Keep it private.</div>
    </div>`).join("");
  const w = window.open("", "_blank");
  w.document.write(`<html><head><title>Login slips</title><style>
    body{font-family:Arial,sans-serif;margin:20px}
    .slip{border:1px dashed #555;padding:10px 12px;margin:0 0 10px;page-break-inside:avoid;font-size:14px;line-height:1.6}
    .h{font-weight:bold}.n{font-size:12px;color:#444}
    </style></head><body>${slips}</body></html>`);
  w.document.close();
  w.focus();
  w.print();
};

// ==========================
// Archive: read-only historical register for one subject
// ==========================
App.Archive = {};
App.Archive._fmt = d => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

App.Archive.showRegister = async function (subject, batch) {
  const out = document.getElementById("archiveRegisterOutput");
  if (!out) return;
  out.innerHTML = "<p>Loading register…</p>";
  try { out.scrollIntoView({ behavior: "smooth", block: "start" }); } catch (e) {}

  try {
    const [data, allStudents, enrollments, assignments, teachers] = await Promise.all([
      App.loadSubjectData(subject.id),
      App.getStudents(),
      App.getEnrollments(),
      App.getSubjectAssignmentsFromFirestore(),
      App.getTeachersFromFirestore()
    ]);
    const fmt = App.Archive._fmt;
    const dates = data.heldDates();
    const teacher = teachers.find(t => String(t.id) === String(assignments[String(subject.id)]));
    const ids = [...new Set([...(enrollments[String(subject.id)] || []).map(String), ...data.recordedStudentIds()])];
    const students = ids.map(id => allStudents.find(st => String(st.id) === id)).filter(Boolean).sort(App.sortByRoll);
    const title = `${subject.name} — ${batch.program} Batch ${batch.year}, Semester ${batch.semester}`;
    const teacherText = App.teacherHistoryText((await App.getAssignmentHistories())[String(subject.id)], teachers)
      || (teacher ? teacher.name + (teacher.status === "FORMER" ? " (Former Staff)" : "") : "Unassigned");

    let html = `<div style="padding:12px; border:1px solid #cbd5e1; border-radius:6px; background:#fff;">
      <h3 style="margin:0 0 6px;">📜 Historical Register <small style="color:#6b7280;">(read-only)</small></h3>
      <div><b>${App.esc(title)}</b></div>
      <div>Teacher: ${App.esc(teacherText)}</div>
      <div>Classes held: <b>${dates.length}</b>${dates.length ? ` (${fmt(dates[0])} to ${fmt(dates[dates.length - 1])})` : ""}</div>`;

    if (!dates.length || !students.length) {
      out.innerHTML = html + "<p>No attendance was recorded for this subject.</p></div>";
      return;
    }

    const rows = students.map(st => {
      const t = data.tally(st.id);
      return { st, t, cells: dates.map(d => {
        const v = data.effective(d, st.id);
        const mark = v === "Present" ? "P" : v === "Absent" ? "AB" : v === "Leave" ? "L" : "—";
        return { mark, corrected: v && data.isCorrected(d, st.id) };
      }) };
    });

    html += `<div style="margin:10px 0;">
        <button id="archRegExcelBtn" class="primary">Download as Excel</button>
        <button id="archRegPrintBtn">Print</button>
      </div>
      <div id="archRegTableWrap" style="overflow-x:auto;">
      <table id="archRegTable" border="1" cellpadding="3" style="border-collapse:collapse; font-size:12px; white-space:nowrap;">
        <tr><th>S.No</th><th>Roll</th><th>Name</th>${dates.map(d => `<th>${d.slice(8, 10)}/${d.slice(5, 7)}</th>`).join("")}
            <th>P</th><th>AB</th><th>L</th><th>%</th></tr>`;
    rows.forEach(({ st, t, cells }, i) => {
      html += `<tr><td>${i + 1}</td><td>${App.esc(st.roll)}</td><td style="text-align:left;">${App.esc(st.name)}</td>` +
        cells.map(c => {
          const bg = c.mark === "P" ? "#d4edda" : c.mark === "AB" ? "#f8d7da" : c.mark === "L" ? "#dbeafe" : "";
          return `<td style="background:${bg}; text-align:center;">${c.mark}${c.corrected ? "*" : ""}</td>`;
        }).join("") +
        `<td><b>${t.present}</b></td><td><b>${t.absent}</b></td><td><b>${t.leave}</b></td><td><b>${t.percent === null ? "—" : t.percent + "%"}</b></td></tr>`;
    });
    const markedRow = dates.map(d => {
      const t = teachers.find(x => String(x.id) === data.markedBy(d));
      return t ? App.initials(t.name) : "";
    });
    html += `<tr style="background:#f8fafc;"><td colspan="3" style="text-align:left;"><i>Marked by</i></td>` +
      markedRow.map(m => `<td style="font-size:10px; text-align:center;">${App.esc(m)}</td>`).join("") + `<td colspan="4"></td></tr>`;
    html += `</table></div>
      <div style="font-size:12px; margin-top:8px;">P = Present | AB = Absent | L = Leave (not counted in %) | — = not recorded | * = corrected (approved by HOD)</div>
    </div>`;
    out.innerHTML = html;

    document.getElementById("archRegExcelBtn").onclick = () => {
      const sheet = rows.map(({ st, t, cells }) => {
        const r = { Roll: st.roll, Name: st.name };
        dates.forEach((d, k) => { r[fmt(d)] = cells[k].mark + (cells[k].corrected ? "*" : ""); });
        r.Present = t.present; r.Absent = t.absent; r.Leave = t.leave; r["%"] = t.percent === null ? "" : t.percent;
        return r;
      });
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheet), "Register");
      const safe = `${subject.name}_${batch.program}${batch.year}_Sem${batch.semester}`.replace(/[^A-Za-z0-9_-]+/g, "_");
      XLSX.writeFile(wb, `Register_${safe}.xlsx`);
    };
    document.getElementById("archRegPrintBtn").onclick = () => {
      const w = window.open("", "_blank");
      w.document.write(`<html><head><title>${App.esc(title)}</title><style>
        body{font-family:Arial,sans-serif;margin:16px} table{border-collapse:collapse;font-size:10px}
        td,th{border:1px solid #444;padding:2px 3px;text-align:center}</style></head><body>
        <h3>${App.esc(title)}</h3><div>Teacher: ${App.esc(teacherText)} | Classes held: ${dates.length}</div><br>
        ${document.getElementById("archRegTable").outerHTML}
        <p style="font-size:11px">P = Present | AB = Absent | * = corrected (approved by HOD)</p></body></html>`);
      w.document.close();
      w.focus();
      w.print();
    };
  } catch (e) {
    console.error(e);
    out.innerHTML = "<p style='color:red;'>Could not load the register. Check your internet connection and try again.</p>";
  }
};

// ==========================
// Recovery email & "Forgot password?"
// A person may confirm their own email. After confirming, they log in with that
// email (it is never shown to anyone else), and can reset a forgotten password
// themselves. Without one, the HOD resets passwords as before.
// ==========================
App.Recovery = {};

App.Recovery.mask = function (email) {
  const [name, domain] = String(email || "").split("@");
  if (!domain) return email || "";
  return name.slice(0, 2) + "***@" + domain;
};

App.Recovery.showPanel = async function () {
  const panel = document.getElementById("recoveryPanel");
  if (!panel) return;
  const status = document.getElementById("recoveryStatus");
  document.getElementById("recEmail").value = "";
  document.getElementById("recPassword").value = "";
  document.getElementById("recMessage").textContent = "";
  status.textContent = "Checking…";
  panel.style.display = "flex";

  const u = auth.currentUser;
  if (u && !Auth.isInternalEmail(u.email)) {
    status.innerHTML = `✅ Active: <b>${App.esc(u.email)}</b><br>You log in with this email address, and can use ` +
      `<b>Forgot password?</b> on the login screen. You can replace it with another email below.`;
    return;
  }
  let pending = "";
  try { pending = ((await Auth.loadProfile(u.uid)) || {}).recoveryEmail || ""; } catch (e) {}
  status.innerHTML = pending
    ? `⏳ A confirmation link was sent to <b>${App.esc(pending)}</b>. Open that email and click the link. ` +
      `Until you do, keep logging in with your login ID.`
    : `Not set up. Add an email address you can always open. After you confirm it, you will log in with that email ` +
      `and can reset a forgotten password yourself.`;
};

App.Recovery.init = function () {
  const panel = document.getElementById("recoveryPanel");
  if (!panel) return;
  const msg = document.getElementById("recMessage");
  const btn = document.getElementById("recSaveBtn");
  document.getElementById("recCloseBtn").onclick = () => { panel.style.display = "none"; };

  btn.onclick = async () => {
    const email = document.getElementById("recEmail").value.trim().toLowerCase();
    const pw = document.getElementById("recPassword").value;
    msg.style.color = "red";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { msg.textContent = "Enter a valid email address."; return; }
    if (Auth.isInternalEmail(email)) { msg.textContent = "Use your own email address."; return; }
    if (!pw) { msg.textContent = "Enter your current password."; return; }

    btn.disabled = true;
    msg.style.color = "#555";
    msg.textContent = "Sending…";
    try {
      const u = auth.currentUser;
      await u.reauthenticateWithCredential(firebase.auth.EmailAuthProvider.credential(u.email, pw));
      await u.verifyBeforeUpdateEmail(email);
      await db.collection("users").doc(u.uid).update({ recoveryEmail: email });
      msg.style.color = "green";
      msg.innerHTML = `A confirmation link was sent to <b>${App.esc(email)}</b> (check spam too). ` +
        `After you click it, <b>log in with this email address</b> instead of your login ID.`;
    } catch (e) {
      console.error(e);
      msg.style.color = "red";
      const c = e && e.code;
      msg.textContent =
        (c === "auth/wrong-password" || c === "auth/invalid-credential") ? "Current password is incorrect." :
        c === "auth/email-already-in-use" ? "This email is already linked to another (possibly old) account. Use a different email, or ask the HOD to remove the old account in Firebase Console → Authentication." :
        c === "auth/invalid-email" ? "That email address is not valid." :
        App.Accounts.errorText(e);
    } finally {
      btn.disabled = false;
    }
  };

  // Login screen: Forgot password?
  const link = document.getElementById("forgotLink");
  const fp = document.getElementById("forgotPanel");
  const fbtn = document.getElementById("forgotBtn");
  const fmsg = document.getElementById("forgotMessage");
  if (link && fp) link.onclick = e => { e.preventDefault(); fp.style.display = fp.style.display === "none" ? "block" : "none"; };
  if (fbtn) fbtn.onclick = async () => {
    const email = document.getElementById("forgotEmail").value.trim().toLowerCase();
    fmsg.style.color = "red";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { fmsg.textContent = "Enter the email address you confirmed."; return; }
    fbtn.disabled = true;
    try {
      await auth.sendPasswordResetEmail(email);
    } catch (e) {
      console.warn("reset email:", e && e.code);   // don't reveal whether the email exists
      if (e && e.code === "auth/network-request-failed") {
        fmsg.textContent = "Could not reach the server. Check your internet connection.";
        fbtn.disabled = false;
        return;
      }
    }
    fbtn.disabled = false;
    fmsg.style.color = "green";
    fmsg.textContent = "If this is a confirmed recovery email, a reset link is on its way (check spam too). " +
      "After resetting, log in with this email and your new password. No email? Ask the HOD to reset your password.";
  };
};

// HOD resetting someone who has a recovery email: suggest self-service first
App.Recovery.confirmHodReset = async function (uid, name) {
  if (!uid) return true;
  let profile = null;
  try { profile = await Auth.loadProfile(uid); } catch (e) {}
  if (!profile || !profile.recoveryEmail) return true;
  return await UI.confirm(`${name} has a recovery email (${App.Recovery.mask(profile.recoveryEmail)}). ` +
    `They can reset their own password with "Forgot password?" on the login screen.\n\n` +
    `Give them a new password anyway? They would then log in with their login ID again, ` +
    `and would need to set up a recovery email again (using a different address).`);
};

// ==========================
// HOD Dashboard — the HOD's home screen
// ==========================
App.HodDash = {};

App.HodDash.init = async function () {
  const dateEl = document.getElementById("hodDashDate");
  const today = new Date().toLocaleDateString("en-CA");
  if (dateEl) dateEl.textContent = new Date().toLocaleDateString("en-GB",
    { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  App.Backup.showLast();
  // Each part loads on its own, so one slow/failed part never blocks the others
  App.updateHODStats().catch(e => console.error("stats", e));
  App.HodDash.renderCorrections().catch(e => console.error("corrections", e));
  App.HodDash.renderToday(today).catch(e => {
    console.error("today", e);
    const box = document.getElementById("hodDashToday");
    if (box) box.innerHTML = "<p style='color:red;'>Could not load today's classes. Check your internet connection.</p>";
  });
};

App.HodDash.renderCorrections = async function () {
  const box = document.getElementById("hodDashCorrections");
  if (!box) return;
  const pending = (await App.getCorrectionRequests()).filter(r => r.status === "pending");
  if (!pending.length) {
    box.innerHTML = "<p style='margin:0;'>✅ No pending requests.</p>";
    return;
  }
  box.innerHTML = `<p style="margin:0 0 8px;"><b style="color:#b45309;">${pending.length}</b> request(s) waiting for your decision.</p>
    <button id="hodDashReviewBtn" class="primary">Review now</button>`;
  document.getElementById("hodDashReviewBtn").onclick = () => showSection("correctionsSection");
};

App.HodDash.renderToday = async function (today) {
  const box = document.getElementById("hodDashToday");
  if (!box) return;
  box.innerHTML = "Loading…";

  const closed = await App.isClosedDay(today);
  if (closed) {
    box.innerHTML = `<p style="margin:0;">🗓️ Today is closed (${App.esc(closed.reason || closed.type)}). No classes expected.</p>`;
    return;
  }

  const [subjects, batches, enrollments, assignments, teachers] = await Promise.all([
    App.getSubjects(), App.getBatches(), App.getEnrollments(),
    App.getSubjectAssignmentsFromFirestore(), App.getTeachersFromFirestore()
  ]);

  // Only subjects of ACTIVE semesters that have students
  const active = subjects.filter(s => {
    const b = batches.find(b => String(b.id) === String(s.batchId) && String(b.semester) === String(s.semester));
    return b && b.status === "ACTIVE" && (enrollments[String(s.id)] || []).length > 0;
  });
  if (!active.length) {
    box.innerHTML = "<p style='margin:0;'>No active subjects with students yet.</p>";
    return;
  }

  const rows = await Promise.all(active.map(async s => {
    const id = `${s.id}_${today}`;
    const [attSnap, cancelSnap] = await Promise.all([
      db.collection("attendance").doc(id).get(),
      db.collection("classCancellations").doc(id).get()
    ]);
    const t = teachers.find(t => String(t.id) === String(assignments[String(s.id)]));
    let state, detail = "", order;
    if (attSnap.exists) {
      const recs = Object.values(attSnap.data().records || {});
      const p = recs.filter(v => App.normalizeStatus(v) === "Present").length;
      const onLeave = (await App._getDocsByIdPrefix("leaves", `${s.id}_${today}_`)).length;
      const a = recs.filter(v => App.normalizeStatus(v) === "Absent").length - onLeave;
      state = "✅ Marked"; detail = `${p} present, ${a} absent` + (onLeave ? `, ${onLeave} on leave` : ""); order = 2;
    } else if (cancelSnap.exists) {
      state = "🚫 Not held"; detail = cancelSnap.data().reason || ""; order = 1;
    } else {
      state = "⏳ Not marked yet"; order = 0;
    }
    return { s, teacher: t ? t.name : "⚠️ No teacher assigned", state, detail, order };
  }));

  rows.sort((x, y) => x.order - y.order || String(x.s.name).localeCompare(String(y.s.name)));
  const marked = rows.filter(r => r.order === 2).length;
  const waiting = rows.filter(r => r.order === 0).length;

  let html = `<p style="margin:0 0 8px;"><b>${marked}</b> of <b>${rows.length}</b> active subjects marked today` +
             (waiting ? ` — <b style="color:#b45309;">${waiting}</b> not marked yet.` : ".") + `</p>
    <table border="1" cellpadding="5" width="100%" style="border-collapse:collapse;">
    <tr><th style="text-align:left;">Subject</th><th>Teacher</th><th>Status</th></tr>`;
  rows.forEach(r => {
    const bg = r.order === 0 ? "#fff7ed" : r.order === 1 ? "#fefce8" : "";
    html += `<tr style="background:${bg}">
      <td style="text-align:left;">${App.esc(App.subjectLabel(r.s, batches))}</td>
      <td>${App.esc(r.teacher)}</td>
      <td><b>${r.state}</b>${r.detail ? `<br><small>${App.esc(r.detail)}</small>` : ""}</td></tr>`;
  });
  box.innerHTML = html + "</table>";
};

// ==========================
// Leave Register (HOD) — every recorded leave; HOD can remove a mistaken one
// ==========================
App.LeaveRegister = {};
App.LeaveRegister.render = async function () {
  const out = document.getElementById("leaveRegisterOutput");
  if (!out) return;
  out.innerHTML = "<p>Loading…</p>";
  try {
    const [snap, students, subjects, teachers] = await Promise.all([
      db.collection("leaves").get(), App.getStudents(), App.getSubjects(), App.getTeachersFromFirestore()
    ]);
    const list = [];
    snap.forEach(doc => list.push({ id: doc.id, ...doc.data() }));
    if (!list.length) { out.innerHTML = "<p>No leaves recorded yet.</p>"; return; }
    list.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    let html = `<table border="1" cellpadding="5" width="100%" style="border-collapse:collapse;">
      <tr><th>Date</th><th>Subject</th><th>Student</th><th>Type</th><th>Reference</th><th>Marked by</th><th>Marked at</th><th></th></tr>`;
    list.forEach(l => {
      const st = students.find(s => String(s.id) === String(l.studentId));
      const sub = subjects.find(s => String(s.id) === String(l.subjectId));
      const t = teachers.find(x => String(x.id) === String(l.markedBy));
      html += `<tr>
        <td>${App.esc(l.date)}</td>
        <td>${App.esc(sub ? sub.name : "Unknown")}</td>
        <td>${App.esc(st ? `${st.roll} - ${st.name}` : "Unknown")}</td>
        <td>${App.esc(App.LEAVE_TYPES[l.type] || l.type)}</td>
        <td>${App.esc(l.reference || "")}</td>
        <td>${App.esc(t ? t.name : "")}</td>
        <td>${l.markedAt ? App.esc(new Date(l.markedAt).toLocaleString()) : ""}</td>
        <td><button data-leave-id="${App.esc(l.id)}">Remove</button></td></tr>`;
    });
    out.innerHTML = html + "</table>";
    out.querySelectorAll("button[data-leave-id]").forEach(b => {
      b.onclick = async () => {
        if (!await UI.confirm("Remove this leave? The day will count as Absent again.", { title: "Remove leave?", okText: "Remove", danger: true })) return;
        const leave = list.find(l => l.id === b.getAttribute("data-leave-id"));
        try {
          await db.collection("leaves").doc(leave.id).delete();
          await App.StudentViews.removeLeave(leave.studentId, leave.subjectId, leave.date)
            .catch(e => console.warn("Student copy of leave not removed", e));
        } catch (e) {
          console.error(e);
          await UI.alert("Could not remove the leave. Check your internet connection and try again.");
        }
        App.LeaveRegister.render();
      };
    });
  } catch (e) {
    console.error(e);
    out.innerHTML = "<p style='color:red;'>Could not load the leave register.</p>";
  }
};

// ==========================
// Settings (HOD)
// ==========================
App.Settings = {};
App.Settings.load = async function () {
  const input = document.getElementById("casualLeaveLimitInput");
  if (input) input.value = await App.getLeaveLimit();
};
App.Settings.save = async function () {
  const input = document.getElementById("casualLeaveLimitInput");
  const n = Number(input.value);
  if (!Number.isInteger(n) || n < 0 || n > 60) { UI.alert("Enter a whole number between 0 and 60."); return; }
  try {
    await App.saveLeaveLimit(n);
    UI.alert(`Saved. Casual leave limit is now ${n} per subject per semester.`);
  } catch (e) {
    console.error(e);
    UI.alert("Could not save. Check your internet connection and try again.");
  }
};

// ==========================
// Backup (HOD) — readable Excel workbook + exact copy (JSON) for restoring
// ==========================
App.Backup = {};
App.Backup.COLLECTIONS = ["batches", "subjects", "teachers", "students", "enrollments", "subjectAssignments", "leaves",
  "attendance", "attendanceCorrections", "correctionRequests", "classCancellations", "dayStatuses", "users"];

App.Backup.fetchAll = async function (onProgress) {
  const out = {};
  for (const c of App.Backup.COLLECTIONS) {
    if (onProgress) onProgress(c);
    const snap = await db.collection(c).get();
    out[c] = {};
    snap.forEach(doc => { out[c][doc.id] = doc.data(); });
  }
  return out;
};

App.Backup._status = function (text, colour) {
  const el = document.getElementById("backupStatus");
  if (el) { el.textContent = text; el.style.color = colour || "#555"; }
};

App.Backup.showLast = function () {
  let last = null;
  try { last = localStorage.getItem("lastBackupAt"); } catch (e) {}
  if (!last) {
    App.Backup._status("⚠️ No backup downloaded on this computer yet.", "#b45309");
    return;
  }
  const days = Math.floor((Date.now() - new Date(last).getTime()) / 86400000);
  const when = new Date(last).toLocaleString();
  if (days >= 7) App.Backup._status(`⚠️ Last backup was ${days} days ago (${when}). Time to download a new one.`, "#b45309");
  else App.Backup._status(`Last backup downloaded on this computer: ${when}`, "#555");
};

App.Backup._done = function (what) {
  try { localStorage.setItem("lastBackupAt", new Date().toISOString()); } catch (e) {}
  App.Backup._status(`✅ ${what} downloaded. Keep it somewhere safe (e.g. Google Drive and a USB stick).`, "green");
};

App.Backup._stamp = () => new Date().toLocaleDateString("en-CA");

App.Backup.downloadJson = async function () {
  try {
    App.Backup._status("Preparing exact copy…");
    const data = await App.Backup.fetchAll(c => App.Backup._status(`Reading ${c}…`));
    const payload = { exportedAt: new Date().toISOString(), projectId: firebaseConfig.projectId, collections: data };
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `attendance_exact_copy_${App.Backup._stamp()}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    App.Backup._done("Exact copy");
  } catch (e) {
    console.error(e);
    App.Backup._status("Backup FAILED: " + App.Accounts.errorText(e), "red");
  }
};

App.Backup.downloadExcel = async function () {
  try {
    App.Backup._status("Preparing Excel backup…");
    const d = await App.Backup.fetchAll(c => App.Backup._status(`Reading ${c}…`));
    const V = c => Object.values(d[c] || {});
    const subj = id => d.subjects[String(id)] || {};
    const stud = id => d.students[String(id)] || V("students").find(s => String(s.id) === String(id)) || {};
    const teacherName = id => (d.teachers[String(id)] || {}).name || "";
    const batch = id => V("batches").find(b => String(b.id) === String(id)) || {};
    const byKeys = (...keys) => (a, b) => {
      for (const k of keys) {
        const c = String(a[k] ?? "").localeCompare(String(b[k] ?? ""), undefined, { numeric: true });
        if (c) return c;
      }
      return 0;
    };

    const sheets = {
      "Batches": V("batches").map(b => ({ Program: b.program, Year: b.year, Semester: b.semester, Status: b.status, BatchId: String(b.id) }))
        .sort(byKeys("Program", "Year", "Semester")),
      "Subjects": V("subjects").map(s => ({
        Subject: s.name, Type: s.type, Program: s.program, Year: s.year, Semester: s.semester,
        Teacher: teacherName((d.subjectAssignments[String(s.id)] || {}).teacherId),
        TeacherHistory: App.teacherHistoryText(App._historyOf(d.subjectAssignments[String(s.id)]), V("teachers")),
        SubjectId: String(s.id)
      })).sort(byKeys("Program", "Year", "Semester", "Subject")),
      "Teachers": V("teachers").map(t => ({ Name: t.name, LoginID: t.loginId || t.username, Status: t.status || "ACTIVE", TeacherId: String(t.id) }))
        .sort(byKeys("Name")),
      "Students": V("students").map(s => {
        const b = batch(s.batchId);
        return { Roll: s.roll, Name: s.name, Program: b.program || "", BatchYear: b.year || "", Status: s.status || "ACTIVE",
                 ExitPathway: s.exitType || "", ExitDate: s.exitDate || "", LoginID: s.loginId || "", StudentId: String(s.id) };
      }).sort(byKeys("Program", "BatchYear", "Roll")),
      "Enrollments": V("enrollments").flatMap(e => (e.students || []).map(sid => {
        const s = subj(e.subjectId), st = stud(sid);
        return { Subject: s.name || String(e.subjectId), Semester: s.semester || "", Roll: st.roll || "", Name: st.name || "",
                 SubjectId: String(e.subjectId), StudentId: String(sid) };
      })).sort(byKeys("Subject", "Roll")),
      "Attendance": V("attendance").flatMap(a => Object.entries(a.records || {}).map(([sid, status]) => {
        const s = subj(a.subjectId), st = stud(sid);
        return { Date: a.date, Subject: s.name || String(a.subjectId), Semester: s.semester || "", Roll: st.roll || "",
                 Name: st.name || "", Status: status, MarkedBy: teacherName(a.markedBy), SubjectId: String(a.subjectId), StudentId: String(sid) };
      })).sort(byKeys("Date", "Subject", "Roll")),
      "Corrections": V("attendanceCorrections").map(c => {
        const st = stud(c.studentId);
        return { Date: c.date, Subject: subj(c.subjectId).name || String(c.subjectId), Roll: st.roll || "", Name: st.name || "",
                 From: c.originalStatus, To: c.correctedStatus || "", Decision: c.decision, Reason: c.reason,
                 DecidedBy: c.approvedBy, DecidedAt: c.timestamp };
      }).sort(byKeys("Date", "Subject", "Roll")),
      "Correction requests": V("correctionRequests").map(r => {
        const st = stud(r.studentId);
        return { Date: r.date, Subject: subj(r.subjectId).name || String(r.subjectId), Roll: st.roll || "", Name: st.name || "",
                 Requested: r.requestedStatus, Reason: r.reason, Status: r.status, RequestedBy: teacherName(r.requestedBy),
                 RequestedAt: r.requestedAt };
      }).sort(byKeys("Date", "Subject")),
      "Leaves": V("leaves").map(l => {
        const st = stud(l.studentId);
        return { Date: l.date, Subject: subj(l.subjectId).name || String(l.subjectId), Roll: st.roll || "", Name: st.name || "",
                 Type: App.LEAVE_TYPES[l.type] || l.type, Reference: l.reference || "", MarkedBy: teacherName(l.markedBy), MarkedAt: l.markedAt };
      }).sort(byKeys("Date", "Subject", "Roll")),
      "Classes not held": V("classCancellations").map(c => ({
        Date: c.date, Subject: subj(c.subjectId).name || String(c.subjectId), Teacher: teacherName(c.teacherId), Reason: c.reason
      })).sort(byKeys("Date", "Subject")),
      "Days closed": Object.entries(d.dayStatuses || {}).map(([date, x]) => ({ Date: date, Type: x.type, Reason: x.reason }))
        .sort(byKeys("Date"))
    };

    const wb = XLSX.utils.book_new();
    Object.entries(sheets).forEach(([name, rows]) => {
      const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ Note: "No records" }]);
      XLSX.utils.book_append_sheet(wb, ws, name);
    });
    XLSX.writeFile(wb, `attendance_backup_${App.Backup._stamp()}.xlsx`);
    App.Backup._done("Excel backup");
  } catch (e) {
    console.error(e);
    App.Backup._status("Backup FAILED: " + App.Accounts.errorText(e), "red");
  }
};

(function wireBackupButtons() {
  const x = document.getElementById("backupExcelBtn");
  const j = document.getElementById("backupJsonBtn");
  if (x) x.onclick = App.Backup.downloadExcel;
  if (j) j.onclick = App.Backup.downloadJson;
})();

// ==========================
// Course Templates (Economics)
// ==========================

App.CourseTemplates = {
  Economics: [
    "Microeconomics",
    "Macroeconomics",
    "Indian Economy",
    "International Economics",
    "Development Economics",
    "Public Economics / Public Finance",
    "Monetary Economics",
    "Growth and Development",
    "Mathematical Economics",
    "Statistics for Economics",
    "Econometrics",
    "Quantitative Methods",
    "Research Methodology",
    "Environmental Economics",
    "Labour Economics",
    "Agricultural Economics",
    "Industrial Economics",
    "Health Economics",
    "Other"
  ]
};

App.getStudents = async function () {
  try {
    const snapshot = await db.collection("students").get();

    const students = [];
    snapshot.forEach(doc => students.push(doc.data()));

    return students;

  } catch (e) {
    console.warn("Firestore student read failed");
  }

  return [];   // ✅ no fallback
};
   
  App.getSubjects = async function () {
  try {
    const snapshot = await db.collection("subjects").get();

    const subjects = [];
    snapshot.forEach(doc => subjects.push(doc.data()));

    return subjects;

  } catch (e) {
    console.warn("Firestore subject read failed");
  }

  return [];   // ✅ no fallback
};

  App.getEnrollments = async function () {
  try {
    const snapshot = await db.collection("enrollments").get();

    const enrollments = {};
    snapshot.forEach(doc => {
      enrollments[doc.id] = doc.data().students || [];
    });

    return enrollments;

  } catch (e) {
    console.warn("Firestore enrollment read failed");
  }

  return {};   // ✅ no fallback
};

App.getBatches = async function () {
  try {
    const snapshot = await db.collection("batches").get();

    const batches = [];
    snapshot.forEach(doc => batches.push(doc.data()));

    // 🔥 FILTER OUT INVALID / GHOST BATCHES
    return batches.filter(b => b.id && b.semester && b.year && b.year !== 0);

  } catch (e) {
    console.warn("Firestore batch read failed");
  }

  return [];
};

  App.encodeBatchKey = function(batch) {
  return `${batch.id}|${batch.semester}`;
  };

  App.decodeBatchKey = function(raw) {
  if (!raw) return null;
  const [id, semester] = raw.split("|");
  return { id, semester };
  };

// ==========================
// Day Status System (Flexible Closures)
// ==========================

// 🔥 NEW: Always try Firestore first
App.getDayStatuses = async function () {
  return await App.getDayStatusesFromFirestore();
};

// 🔥 Keep local backup (for now)

// status object format:
// {
//   date: "YYYY-MM-DD",
//   type: "holiday" | "weather" | "emergency" | "admin" | "custom",
//   reason: "Heavy snowfall",
//   markedBy: "HOD",
//   timestamp: ISOString
// }

App.getDayStatus = async function (date) {
  const map = await App.getDayStatuses();
  return map[date] || null;
};


// Returns true if saved
App.setDayStatus = async function (date, obj) {
  return await App.saveDayStatusToFirestore(date, obj);
};


App.clearDayStatus = async function (date) {

  // 🔥 Remove from Firestore
  await db.collection("dayStatuses").doc(date).delete();
};


App.isClosedDay = async function (date) {
  if (App.isSundayDate(date)) return {
    type: "sunday",
    reason: "Sunday"
  };

  return await App.getDayStatus(date);
};


// ==========================
// Class Cancellation / Teacher Leave System
// ==========================

// storage format:
// {
//   "subjectId|date": {
//      subjectId,
//      date,
//      teacherId,
//      reason,
//      timestamp
//   }
// }



App.cancelClass = async function ({ subjectId, date, teacherId, reason }) {

  const data = {
    subjectId,
    date,
    teacherId,
    reason,
    timestamp: new Date().toISOString()
  };

  // ✅ Firestore write
  try {
    data.subjectId = String(subjectId);
    const docId = `${data.subjectId}_${date}`;
    await db.collection("classCancellations").doc(docId).set(data);
    return true;
  } catch (e) {
    console.warn("Firestore cancel save failed", e);
    return false;
  }

  // ❌ DISABLED local backup (Phase 1 migration)
  // const map = App.getClassCancellations();
  // const key = `${subjectId}|${date}`;
  // map[key] = data;
  // App.setClassCancellations(map);
};

App.getClassCancellation = async function (subjectId, date) {

  // 🔥 Try Firestore first
  try {
    const docId = `${subjectId}_${date}`;
    const doc = await db.collection("classCancellations").doc(docId).get();

    if (doc.exists) return doc.data();

  } catch (e) {
    console.warn("Firestore cancel read failed", e);
  }

  return null;
};



App.getAttendance = async function (subjectId, date) {

  const docId = `${subjectId}_${date}`;

  try {
    const doc = await db.collection("attendance").doc(docId).get();

    if (doc.exists) {
      return doc.data().records;
    }

  } catch (e) {
    console.warn("Firestore read failed", e);
  }

  // fallback to LocalStorage
  return {};
};



// ==========================
// Admin Module
// ==========================

// ==========================
// Day Closure Manager (NEW)
// ==========================

const closedDayDate = document.getElementById("closedDayDate");
const closedDayType = document.getElementById("closedDayType");
const closedDayReason = document.getElementById("closedDayReason");
const addClosedDayBtn = document.getElementById("addClosedDayBtn");
const closedDayList = document.getElementById("closedDayList");

async function renderClosedDays() {
  const map = await App.getDayStatuses();
  closedDayList.innerHTML = "";

  const dates = Object.keys(map).sort();

  if (dates.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No closed days marked.";
    li.style.fontStyle = "italic";
    closedDayList.appendChild(li);
    return;
  }

  dates.forEach(date => {
    const info = map[date];
    const li = document.createElement("li");

    li.innerHTML = `
      <b>${App.esc(date)}</b> — ${App.esc(info.reason)}
      <span style="margin-left:auto; color:#888;">(${App.esc(info.type)})</span>
    `;

    const delBtn = document.createElement("button");
    delBtn.textContent = "Remove";
    delBtn.style.marginLeft = "10px";

    delBtn.onclick = async () => {
      delBtn.disabled = true;
      try {
        await App.clearDayStatus(date);
      } catch (e) {
        console.error(e);
        await UI.alert("Could not remove the closed day. Check your internet connection and try again.");
      }
      await renderClosedDays();
    };

    li.appendChild(delBtn);
    closedDayList.appendChild(li);
  });
}

if (addClosedDayBtn) {
  addClosedDayBtn.onclick = async () => {
    const date = closedDayDate.value;
    const type = closedDayType.value;
    const reason = closedDayReason.value.trim();

    if (!date || !reason) {
      UI.alert("Date and reason required");
      return;
    }

    addClosedDayBtn.disabled = true;
    const saved = await App.setDayStatus(date, {
      date,
      type,
      reason,
      markedBy: "HOD",
      timestamp: new Date().toISOString()
    });
    addClosedDayBtn.disabled = false;

    if (!saved) {
      UI.alert("Could not mark the day closed. Check your internet connection and try again.");
      return;
    }
    closedDayDate.value = "";
    closedDayReason.value = "";

    await renderClosedDays();
  };
}


  const subjectInput = document.getElementById("subjectNameInput");
// ==========================
// Course Template Binding
// ==========================

const templateSelect = document.getElementById("courseTemplateSelect");

if (templateSelect && App.CourseTemplates && App.CourseTemplates.Economics) {
  App.CourseTemplates.Economics.forEach(name => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    templateSelect.appendChild(opt);
  });

  templateSelect.onchange = () => {
    if (templateSelect.value && subjectInput) {
      subjectInput.value = templateSelect.value;
    }
  };
}
  const subjectBatchSelect = document.getElementById("subjectBatchSelect");
  const subjectTypeSelect = document.getElementById("subjectTypeSelect");
  const addSubjectBtn = document.getElementById("addSubjectBtn");
  const subjectList = document.getElementById("subjectList");

  const excelInput = document.getElementById("excelFile");
  const uploadBtn = document.getElementById("uploadExcelBtn");
  const uploadStatus = document.getElementById("uploadStatus");
  const studentUploadBatchSelect = document.getElementById("studentUploadBatchSelect");
  const studentUploadSubjectSelect = document.getElementById("studentUploadSubjectSelect");

  
// ==========================
// Batch Manager (FIXED: per-batch open/close)
// ==========================

const batchProgram = document.getElementById("batchProgram");
const batchSemester = document.getElementById("batchSemester");

// ==========================
// Semester Presets by Program
// ==========================

function loadSemesterOptions(program) {
  batchSemester.innerHTML = '<option value="">Select Semester</option>';

  let start = 1;
  let end = 1;

  if (program === "UG") {
    start = 1; end = 8;
  } else if (program === "PG") {
    start = 1; end = 4;
  } else if (program === "IG") {
    start = 7; end = 10;
  }

  for (let i = start; i <= end; i++) {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = `Semester ${i}`;
    batchSemester.appendChild(opt);
  }
}

// initial load
loadSemesterOptions(batchProgram.value);

// update on program change
batchProgram.onchange = () => {
  loadSemesterOptions(batchProgram.value);
};
const batchYearInput = document.getElementById("batchYear");
const addBatchBtn = document.getElementById("addBatchBtn");
const batchList = document.getElementById("batchList");

App.isBatchOpen = async function (batchId, semester) {
  const batches = await App.getBatches();

  const batch = batches.find(
    b => String(b.id) === String(batchId) &&
         String(b.semester) === String(semester)
  );

  return batch && batch.status === "ACTIVE";
};

// ✅ NEW: Targets the exact semester row to prevent Sem 1/Sem 2 collisions
App.setBatchStatus = async function (batchId, semester, status) {
  const batches = await App.getBatches();
  
  // 1. Target the PRECISE row using ID + Semester
  const batch = batches.find(b => String(b.id) === String(batchId) && String(b.semester) === String(semester));
  
  let saved = false;
  if (batch) {
  // Keep a trail of every status change (who / when)
  const history = Array.isArray(batch.statusHistory) ? batch.statusHistory : [];
  history.push({ status, at: new Date().toISOString(), by: (Auth.currentUser() || {}).loginId || "HOD" });
  batch.statusHistory = history;
  batch.status = status;

  saved = await App.saveBatchToFirestore(batch);
  if (!saved) UI.alert("Could not save the change. Check your internet connection and try again.");
  }

  renderBatches(); 
  renderSubjects(); 
  // Refresh dropdowns so changes reflect immediately
  if (typeof loadBatchesIntoSubjectSelect === "function") loadBatchesIntoSubjectSelect();
  if (typeof loadSubjectsIntoAssignSelect === "function") loadSubjectsIntoAssignSelect();
};

  async function renderBatches() {
  const batches = await App.getBatches();
  batchList.innerHTML = "";

  batches.forEach((b, index) => {
  if (!b.id || !b.semester || b.year === 0) return;
    // RULE: Archived semesters should not clutter the operational screen
    if (b.status === 'ARCHIVED') return;
    const li = document.createElement("li");

    // Unified source of truth: use the status on the object or the tracker
    const status = b.status || "ACTIVE";
    
    let statusText = "ACTIVE";
    let color = "green";
    
    if (status === "CLOSED") {
      statusText = "CLOSED";
      color = "orange";
    } else if (status === "ARCHIVED") {
      statusText = "ARCHIVED";
      color = "red";
    }

    li.innerHTML = `
      ${b.program} Sem ${b.semester} (Batch ${b.year})
      <b style="color:${color}; margin-left:10px;">[${statusText}]</b>
    `;
     // --- TOGGLE BUTTON (Lifecycle Transition) ---
    const toggleBtn = document.createElement("button");
    // Button label based on current state
    toggleBtn.textContent = status === "ACTIVE" ? "Close Semester" : "Set Active";
    toggleBtn.style.marginLeft = "10px";

    toggleBtn.onclick = async () => {
      // Logic: If ACTIVE, change to CLOSED. If CLOSED or ARCHIVED, change to ACTIVE.
      const nextStatus = status === "ACTIVE" ? "CLOSED" : "ACTIVE";
      // 🔑 THE FIX: Passing the semester ensures Sem 1 doesn't override Sem 2
      App.setBatchStatus(b.id, b.semester, nextStatus); 
      // renderBatches() is now called automatically inside setBatchStatus
    };
    // --- ARCHIVE BUTTON (Final Lifecycle Step) ---
    const archiveBtn = document.createElement("button");
    archiveBtn.textContent = "Archive";
    archiveBtn.style.marginLeft = "10px";
    archiveBtn.style.background = "#6b7280"; // Muted grey
    archiveBtn.style.color = "white";

    archiveBtn.onclick = async () => {
      if (await UI.confirm("This moves the semester to the Archive Room as read-only history.\n\n(It can be restored later from the Archive Room.)", { title: "Archive semester?", okText: "Archive", danger: true })) {
        // 🔑 THE FIX: Target only the specific semester you clicked
        App.setBatchStatus(b.id, b.semester, "ARCHIVED");
        // renderBatches() is now called automatically inside setBatchStatus
      }
    };
    
    // Only show the Archive button if the semester is currently CLOSED
    if (status === "CLOSED") {
      li.appendChild(archiveBtn);
    }

    // --- DELETE BUTTON (Data Integrity Shield) ---
    const delBtn = document.createElement("button");
    delBtn.textContent = "Delete";
    delBtn.style.marginLeft = "10px";

    delBtn.onclick = async () => {
      const enrollments = await App.getEnrollments();
      const attendanceIndex = await App.getAttendanceIndex();

    const hasHistory = (await App.getSubjects()).some(sub =>
    String(sub.batchId) === String(b.id) &&
    String(sub.semester) === String(b.semester) &&   // 🔥 CRITICAL FIX
    (
    (enrollments[String(sub.id)]?.length > 0) ||
    (
      attendanceIndex[String(sub.id)] &&
      Object.keys(attendanceIndex[String(sub.id)]).length > 0
    )
    )
    );

      if (hasHistory) {
        // Block deletion of real academic history
        UI.alert("INTEGRITY PROTECT: This semester has historical activity. It cannot be deleted. Use 'Archive' (coming next) to hide it.");
      } else {
        // Allow deletion only for empty/mistaken entries
        if (await UI.confirm("No history found for this semester. Delete this mistaken entry permanently?", { title: "Delete semester?", okText: "Delete", danger: true })) {

       const success = await App.deleteBatchFromFirestore(b.id, b.semester);

       if (!success) {
       UI.alert("Delete failed. Check console.");
       return;
       }

  await renderBatches();
  await loadBatchesIntoSubjectSelect();
  await loadBatchesForStudentUpload();
}
      }
    };

    li.appendChild(toggleBtn);
    li.appendChild(delBtn);
    batchList.appendChild(li);
  });
}

addBatchBtn.onclick = async () => {
  const program = batchProgram.value;
  const semester = batchSemester.value;
  const year = batchYearInput.value;

  if (!semester || !year) {
    UI.alert("Enter semester and year");
    return;
  }

  const batches = await App.getBatches();

  // 🏛️ RE-USE EXISTING BATCH ID LOGIC
  const existingCohort = batches.find(
    b => b.program === program && String(b.year) === String(year)
  );

  const batchId = existingCohort ? existingCohort.id : Date.now();

  const semesterExists = batches.find(
    b => b.id === batchId && String(b.semester) === String(semester)
  );

  if (semesterExists) {
    UI.alert("This semester already exists for this batch.");
    return;
  }

  batches.push({
    id: batchId, // 🔗 ID remains the same across semesters
    program,
    semester,
    year: Number(year),
    status: 'ACTIVE' 
  });
 try {
  await App.saveBatchToFirestore({
    id: batchId,
    program,
    semester,
    year: Number(year),
    status: "ACTIVE"
  });
} catch (e) {
  console.warn("Firestore batch mirror failed", e);
}


  batchSemester.value = "";
  batchYearInput.value = "";
  renderBatches();
  loadBatchesIntoSubjectSelect();
  loadBatchesForStudentUpload();
};

  // ==========================
  // Subject Manager
  // ==========================

 async function loadBatchesIntoSubjectSelect() {
  const batches = await App.getBatches();
  subjectBatchSelect.innerHTML = "";

      batches.forEach(b => {
      if (b.status === 'ACTIVE') {
      const opt = document.createElement("option");
      opt.value = App.encodeBatchKey(b);

      opt.textContent = `${b.program} Sem ${b.semester} (Batch ${b.year})`;
      subjectBatchSelect.appendChild(opt);
    }
  });
  }

  async function renderSubjects() {
  const subjects = await App.getSubjects();
  const batches = await App.getBatches(); // 🔑 Added to check status
  subjectList.innerHTML = "";

  subjects.forEach((sub, index) => {
    // 🛡️ THE ARCHITECTURAL FILTER: Find the status of this specific semester
    const batch = batches.find(b => String(b.id) === String(sub.batchId) && String(b.semester) === String(sub.semester));

    // 🔒 If the semester is ARCHIVED, do not show it in the operational Admin list
    if (batch && batch.status === 'ARCHIVED') return;

    const fullBatchLabel = `${sub.program} Sem ${sub.semester} (Batch ${sub.year})`;
    
    const li = document.createElement("li");
    li.textContent = `${sub.name} (${fullBatchLabel}) [${sub.type || "NO TYPE"}]`;

    const btn = document.createElement("button");
    btn.textContent = "Delete";
    btn.style.marginLeft = "10px";

    btn.onclick = async () => {

  // 🔒 Check REAL attendance from Firestore/localStorage
let hasAttendance = false;
try {
  hasAttendance = Object.keys(await App.getAttendanceForSubject(sub.id)).length > 0;
} catch (e) {
  UI.alert("Could not check attendance history (network problem). Nothing was deleted.");
  return;
}

if (hasAttendance) {
  UI.alert("ACADEMIC LOCK: Attendance exists for this subject. Cannot delete.");
  return;
}
    if (await UI.confirm(`Delete ${sub.name} for ${fullBatchLabel}?`, { title: "Delete subject?", okText: "Delete", danger: true })) {

    const success = await App.deleteSubjectFromFirestore(sub.id);

    if (!success) {
    UI.alert("Delete failed. Check your internet connection and try again.");
    return;
  }
    await renderSubjects();
    await loadSubjectsForStudentUpload();
    await loadSubjectsIntoAssignSelect();
    await renderTeacherAssignments();
    await loadBatchesForStudentManager();
    }
    };

    li.appendChild(btn);
    subjectList.appendChild(li);
    });
    }

  addSubjectBtn.onclick = async () => {
  const name = subjectInput.value.trim();
  const rawValue = subjectBatchSelect.value; 
  const type = subjectTypeSelect.value;

  if (!name || !rawValue) {
    UI.alert("Enter subject name and select a batch");
    return;
  }

  const [batchId, semesterNum] = rawValue.split("|");
  const batches = await App.getBatches();
  const batch = batches.find(b => String(b.id) === String(batchId) && String(b.semester) === String(semesterNum));

  if (!batch) return;

  const subjects = await App.getSubjects();
  // 🚫 No duplicate subject names in the same semester (any type; ignores capitals and extra spaces)
  const sameName = v => String(v || "").trim().replace(/\s+/g, " ").toLowerCase();
  const exists = subjects.find(s =>
    String(s.batchId) === String(batchId) &&
    String(s.semester) === String(batch.semester) &&
    sameName(s.name) === sameName(name)
  );
  if (exists) {
    UI.alert(`"${exists.name}" [${exists.type}] already exists in ${batch.program} Semester ${batch.semester} (Batch ${batch.year}).\n\nNo new subject was added.`);
    return;
  }
  const id = Date.now();

  const newSubject = {
    id, name, batchId: batch.id, type,
    program: batch.program, semester: batch.semester, year: batch.year
  };

  subjects.push(newSubject);
  try {
  await App.saveSubjectToFirestore(newSubject);
} catch (e) {
  console.warn("Firestore subject mirror failed", e);
}

  // 🔁 A new subject in a synced group starts with that group's current student list
  const groupMates = App.syncGroup(newSubject, subjects, batches)
    .filter(s => String(s.id) !== String(id));
  if (groupMates.length) {
    const enrollments = await App.getEnrollments();
    const withStudents = groupMates.filter(s => (enrollments[String(s.id)] || []).length > 0);
    // Prefer the latest semester up to this one (it includes late joiners)
    const earlier = withStudents.filter(s => Number(s.semester) <= Number(newSubject.semester));
    const pool = earlier.length ? earlier : withStudents;
    const source = pool.sort((a, b) => Number(b.semester) - Number(a.semester))[0];
    if (source) {
      await App.saveEnrollmentsToFirestore(id, [...enrollments[String(source.id)]]);
      console.log(`Enrollment copied from ${source.name} (Sem ${source.semester}).`);
    }
  }

  subjectInput.value = "";
  await renderSubjects();
  await loadSubjectsForStudentUpload();
  await loadSubjectsIntoAssignSelect(); 
  await loadBatchesForStudentManager(); 
};

  // ==========================
  // Teacher Account Manager
  // ==========================

  const teacherNameInput = document.getElementById("teacherNameInput");
  const teacherExcelFile = document.getElementById("teacherExcelFile");
  const uploadTeacherExcelBtn = document.getElementById("uploadTeacherExcelBtn");
  const teacherUploadStatus = document.getElementById("teacherUploadStatus");
  const teacherUsernameInput = document.getElementById("teacherUsernameInput");
  const teacherPasswordInput = document.getElementById("teacherPasswordInput");
  const addTeacherBtn = document.getElementById("addTeacherBtn");
  const teacherList = document.getElementById("teacherList");


      async function renderTeachers() {
      const teachers = await App.getTeachersFromFirestore();
      teacherList.innerHTML = "";

      // Former teachers are kept (history) but hidden unless the HOD asks to see them
      const isFormer = t => (t.status || "ACTIVE") === "FORMER";
      const formerCount = teachers.filter(isFormer).length;
      const visible = teachers
        .filter(t => App._showFormerTeachers || !isFormer(t))
        .sort((a, b) => (isFormer(a) - isFormer(b)) || String(a.name).localeCompare(String(b.name)));

      visible.forEach((t, index) => {
      const li = document.createElement("li");
      
      // 1. Determine Status (Default to ACTIVE if label is missing)
      const status = t.status || "ACTIVE";
      const color = status === "ACTIVE" ? "green" : "red";

      // 2. 🛡️ Create a Span for text (This protects the button from being erased)
      const infoSpan = document.createElement("span");
      infoSpan.textContent = `${t.name} | ${t.username}`;
      
      // 3. Create a badge for the Status
      const badge = document.createElement("b");
      badge.textContent = ` [${status}]`;
      badge.style.color = color;
      badge.style.marginLeft = "10px";

      const btn = document.createElement("button");
      
      // 🔄 Change button text and style based on status
      if (status === "ACTIVE") {
        btn.textContent = "Delete / Deactivate";
        btn.style.background = ""; // Default color
      } else {
        btn.textContent = "Reactivate Teacher";
        btn.style.background = "#27ae60"; // Professional green
        btn.style.color = "white";
      }
      
      btn.style.marginLeft = "10px";

      btn.onclick = async () => {
  const attendanceIndex = await App.getAttendanceIndex();
  const subjectTeacherMap = await App.getSubjectAssignmentsFromFirestore();

  // --- CASE 1: REACTIVATING ---
  if (status === "FORMER") {
    if (await UI.confirm("Give this teacher access again?", { title: "Reactivate teacher?", okText: "Reactivate" })) {
      await db.collection("teachers").doc(t.id).update({
       status: "ACTIVE"
       });
      await App.Accounts.setActive(t.uid, true).catch(e => console.warn(e));
      renderTeachers();
      loadTeachersIntoAssignSelect();
      renderTeacherAssignments();
    }
    return;
  }

  // --- CASE 2: SMART AUDIT (True History vs. Error) ---
  // We only lock them as 'FORMER' if they have actually marked a register
  const hasRealAttendanceHistory = Object.keys(attendanceIndex).some(subId => {
    return String(subjectTeacherMap[subId]) === String(t.id);
  });

  if (hasRealAttendanceHistory) {
    // PROTECT HISTORY: Only Deactivation allowed
    if (await UI.confirm("This teacher has academic history, so the account is kept as FORMER (login stops working; records stay).", { title: "Deactivate teacher?", okText: "Deactivate", danger: true })) {
      await db.collection("teachers").doc(t.id).update({
       status: "FORMER"
       });
      await App.Accounts.setActive(t.uid, false).catch(e => console.warn(e));   // login stops working
      // Sever current assignments so they don't appear in active lists
      
      for (const subId of Object.keys(subjectTeacherMap)) {
    if (String(subjectTeacherMap[subId]) === String(t.id)) {
    await App.removeSubjectAssignmentFromFirestore(subId);
    }
    }
      renderTeachers();
      loadTeachersIntoAssignSelect();
      renderTeacherAssignments();
    }
  } else {
    // ERASE ERROR: Permanent deletion allowed because no data is lost
    if (await UI.confirm("No attendance records found. Delete this teacher account permanently?", { title: "Delete teacher?", okText: "Delete", danger: true })) {
      await db.collection("teachers").doc(t.id).delete();
      await App.Accounts.removeLogin(t.uid, t.uid ? (t.loginId || t.username) : null).catch(e => console.warn(e));
      await renderTeachers();
      await loadTeachersIntoAssignSelect();
      await renderTeacherAssignments();
    }
  }
};

      // 🔑 Login status
      infoSpan.textContent = t.uid
        ? `${t.name} | login ID: ${t.loginId || t.username}`
        : `${t.name} | ${t.username} (no login yet)`;
      const loginBtn = document.createElement("button");
      loginBtn.style.marginLeft = "10px";
      loginBtn.textContent = t.uid ? "Reset password" : "Create login";
      loginBtn.onclick = () => App.Accounts.teacherLoginDialog(t);

      // 4. Assemble the row piece by piece
      li.appendChild(infoSpan);
      li.appendChild(badge);
      li.appendChild(btn);
      if (status === "ACTIVE") li.appendChild(loginBtn);
      teacherList.appendChild(li);
    });

      if (formerCount > 0) {
        const toggle = document.createElement("li");
        toggle.style.background = "transparent";
        toggle.style.border = "none";
        const link = document.createElement("a");
        link.href = "#";
        link.id = "toggleFormerTeachers";
        link.textContent = App._showFormerTeachers
          ? `Hide former teachers (${formerCount})`
          : `Show former teachers (${formerCount})`;
        link.onclick = e => {
          e.preventDefault();
          App._showFormerTeachers = !App._showFormerTeachers;
          renderTeachers();
        };
        toggle.appendChild(link);
        teacherList.appendChild(toggle);
      }
  }

 // ==========================
// Manual Add Teacher
// ==========================

  addTeacherBtn.onclick = async () => {
  const name = teacherNameInput.value.trim();
  const username = Auth.normalizeLoginId(teacherUsernameInput.value);
  const password = teacherPasswordInput.value.trim();

  if (!name || !username || !password) {
    UI.alert("Fill all teacher fields");
    return;
  }
  if (!Auth.isValidLoginId(username)) {
    UI.alert("Username can use only letters, numbers, dots and dashes (e.g. asifa or a.bhat).");
    return;
  }
  if (password.length < 6) {
    UI.alert("Starting password must be at least 6 characters.");
    return;
  }

  const teachers = await App.getTeachersFromFirestore();
  if (teachers.find(t => Auth.normalizeLoginId(t.username) === username) ||
      await App.Accounts.loginIdOwner(username)) {
    UI.alert("This username already exists");
    return;
  }

  addTeacherBtn.disabled = true;
  try {
    const teacher = await App.addTeacherToFirestore({ name, username });
    if (!teacher) throw new Error("Could not save the teacher.");
    await App.Accounts.issueLogin({
      loginId: username, password,
      profile: { role: "Teacher", name, teacherId: String(teacher.id) },
      owner: { collection: "teachers", id: teacher.id, data: teacher }
    });
    UI.alert(`Teacher added.\n\nLogin ID: ${username}\nStarting password: ${password}\n\n` +
          `They will choose their own password at first login.`);
    teacherNameInput.value = "";
    teacherUsernameInput.value = "";
    teacherPasswordInput.value = "";
  } catch (e) {
    console.error(e);
    UI.alert(App.Accounts.errorText(e) + "\n\nIf the teacher appears in the list without a login, use its 'Create login' button.");
  } finally {
    addTeacherBtn.disabled = false;
  }

  await renderTeachers();
  await loadTeachersIntoAssignSelect();
  };

// ==========================
// Teacher Excel Upload (ROBUST)
// ==========================

if (uploadTeacherExcelBtn) {
  uploadTeacherExcelBtn.onclick = () => {
    const file = teacherExcelFile.files[0];
    if (!file) {
      UI.alert("Select an Excel file");
      return;
    }

    const reader = new FileReader();
    reader.onload = async e => {
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      const teachers = await App.getTeachersFromFirestore();
      let added = 0;
      const generated = [], problems = [];

      for (const row of rows) {
        const name = String(row.Name || row.name || row.NAME || "").trim();
        const uname = Auth.normalizeLoginId(row.Username || row.username || row.USERNAME || "");
        let password = String(row.Password || row.password || row.PASSWORD || "").trim();
        if (!name || !uname) continue;

        if (!Auth.isValidLoginId(uname)) { problems.push(`${name}: username "${uname}" not allowed`); continue; }
        if (teachers.find(t => Auth.normalizeLoginId(t.username) === uname) ||
            await App.Accounts.loginIdOwner(uname)) { problems.push(`${name}: username ${uname} already exists`); continue; }
        if (password.length < 6) { password = Auth.generatePassword(); generated.push(`${name} — ${uname} — ${password}`); }

        teacherUploadStatus.textContent = `Adding ${name}…`;
        try {
          const teacher = await App.addTeacherToFirestore({ name, username: uname });
          if (!teacher) throw new Error("Could not save the teacher.");
          await App.Accounts.issueLogin({
            loginId: uname, password,
            profile: { role: "Teacher", name, teacherId: String(teacher.id) },
            owner: { collection: "teachers", id: teacher.id, data: teacher }
          });
          added++;
          teachers.push(teacher);
        } catch (e) {
          console.error(e);
          problems.push(`${name}: ${App.Accounts.errorText(e)}`);
          if (e && e.code === "auth/too-many-requests") break;
        }
      }

      await renderTeachers();
      await loadTeachersIntoAssignSelect();

      teacherUploadStatus.textContent =
        `Added ${added} teacher(s) with logins.` +
        (generated.length ? ` Passwords were generated for: ${generated.join("; ")}.` : "") +
        (problems.length ? ` Not added: ${problems.join("; ")}.` : "");
    };

    reader.readAsArrayBuffer(file);
  };
}

 // ==========================
// Teacher ↔ Subject Assignment
// (ONE teacher per subject, reassignment-safe)
// ==========================

const assignTeacherSelect = document.getElementById("assignTeacherSelect");
const assignSubjectSelect = document.getElementById("assignSubjectSelect");
const assignSubjectBtn = document.getElementById("assignSubjectBtn");
const teacherAssignmentList = document.getElementById("teacherAssignmentList");

// --------------------------
// Load teachers
// --------------------------

  async function loadTeachersIntoAssignSelect() {
  const teachers = await App.getTeachersFromFirestore();
  assignTeacherSelect.innerHTML = "";

  teachers.forEach(t => {
    // RULE: Only show ACTIVE teachers for new assignments
    if (t.status === 'FORMER') return; 

    const opt = document.createElement("option");
    opt.value = String(t.id);
    opt.textContent = t.name;
    assignTeacherSelect.appendChild(opt);
  });
}

// --------------------------
// Load subjects
// --------------------------
 async function loadSubjectsIntoAssignSelect() {
  const subjects = await App.getSubjects();
  const batches = await App.getBatches();
  assignSubjectSelect.innerHTML = "";

  subjects.forEach(s => {
    // 🔑 THE FIX: Use the Semester/Year/Program stored DIRECTLY on the Subject object
    const batchText = `${s.program} | Batch ${s.year} | Sem ${s.semester}`;

    // Precise check to hide archived/closed semesters (Matches BOTH ID and Semester)
    const batch = batches.find(b => String(b.id) === String(s.batchId) && String(b.semester) === String(s.semester));
    if (batch && (batch.status === 'ARCHIVED' || batch.status === 'CLOSED')) return;

    const opt = document.createElement("option");
    opt.value = String(s.id);
    opt.textContent = `${s.name} (${s.type} | ${batchText})`;
    assignSubjectSelect.appendChild(opt);
  });
}

// --------------------------
// Render assignments (with batch + semester)
// --------------------------

  async function renderTeacherAssignments() {
  const teachers = await App.getTeachersFromFirestore();
  const subjects = await App.getSubjects();
  const batches = await App.getBatches(); // 🔑 RE-ADDED: To check for ARCHIVED status
  const subjectTeacherMap = await App.getSubjectAssignmentsFromFirestore();

  teacherAssignmentList.innerHTML = "";

  teachers.forEach(t => {
    if (t.status === 'FORMER') return; 

    // 🛡️ THE FIX: Filter out subjects belonging to ARCHIVED semesters
    const mySubjects = subjects.filter(s => {
      const isAssigned = String(subjectTeacherMap[String(s.id)]) === String(t.id);
      
      // Find the specific batch/semester row to check its status
      const batch = batches.find(b => String(b.id) === String(s.batchId) && String(b.semester) === String(s.semester));
      
      const isNotArchived = batch && batch.status !== 'ARCHIVED';
      return isAssigned && isNotArchived;
    });

    const labels = mySubjects.map(s => {
      const batchText = `${s.program} Batch ${s.year} Sem ${s.semester}`;
      return `${s.name} (${s.type} | ${batchText})`;
    });

    const li = document.createElement("li");
    li.textContent = `${t.name} → ${labels.join(", ") || "No active subjects assigned"}`;
    teacherAssignmentList.appendChild(li);
  });
}

// --------------------------
// Assign / Replace teacher
// --------------------------

  assignSubjectBtn.onclick = async () => {
  const teacherId = assignTeacherSelect.value;
  const subjectId = assignSubjectSelect.value;

  if (!teacherId || !subjectId) {
    UI.alert("Select teacher and subject");
    return;
  }

  // 🔥 NEW: Save to Firestore
  await App.saveSubjectAssignmentToFirestore(subjectId, teacherId);


  await renderTeacherAssignments();
  await loadSubjectsIntoAssignSelect();
};

// (Admin lists load when the HOD opens the Admin Panel — see showSection)

// ==========================
// Student Manager Helpers
// ==========================

  async function loadBatchesForStudentManager() {
  const batchSelect = document.getElementById("studentManagerBatchSelect");
  const subjectSelect = document.getElementById("studentManagerSubjectSelect");

  if (!batchSelect || !subjectSelect) return;

  const batches = await App.getBatches();
  batchSelect.innerHTML = `<option value="">Select Batch</option>`;

  batches.forEach(b => {
  if (b.status === "ARCHIVED") return;
  const opt = document.createElement("option");
  opt.value = App.encodeBatchKey(b);
  opt.textContent = `${b.program} Batch ${b.year} Sem ${b.semester}`;
  batchSelect.appendChild(opt);
  });

  subjectSelect.innerHTML = `<option value="">Select Subject</option>`;
}

  document.getElementById("studentManagerBatchSelect").onchange = async function () {
  const decoded = App.decodeBatchKey(this.value);
  const subjectSelect = document.getElementById("studentManagerSubjectSelect");
  subjectSelect.innerHTML = `<option value="">Select Subject</option>`;

  if (!decoded) return;

  const { id: batchId, semester } = decoded;
  const batches = await App.getBatches();
  
  // Find the exact Batch record for THIS specific semester
  const selectedBatch = batches.find(b => 
    String(b.id) === String(batchId) && String(b.semester) === String(semester)
  );
  
  if (!selectedBatch) return;

  // ✅ PRECISE FILTER: Show ONLY subjects for this ID and this Semester
  const subjects = (await App.getSubjects()).filter(s => 
    String(s.batchId) === String(batchId) && 
    String(s.semester) === String(selectedBatch.semester)
  );

  subjects.forEach(s => {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = `${s.name} (${s.type} | ${s.program} Sem ${s.semester})`;
    subjectSelect.appendChild(opt);
  });
};
  // ==========================
// Student Upload Helpers
// ==========================

  async function loadBatchesForStudentUpload() {
  const batches = await App.getBatches();
  studentUploadBatchSelect.innerHTML = "";

  if (batches.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No batches available";
    studentUploadBatchSelect.appendChild(opt);
    return;
  }

     batches.forEach(b => {
     if (b.status === "ARCHIVED") return;
     const opt = document.createElement("option");
     opt.value = App.encodeBatchKey(b);
     opt.textContent = `${b.program} | Batch ${b.year} | Sem ${b.semester}`;
     studentUploadBatchSelect.appendChild(opt);
     });
     await loadSubjectsForStudentUpload();
     }

  async function loadSubjectsForStudentUpload() {
  const rawValue = studentUploadBatchSelect.value; // Holds "ID|Semester"
  studentUploadSubjectSelect.innerHTML = "";

  if (!rawValue) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "Select batch first";
    studentUploadSubjectSelect.appendChild(opt);
    return;
  }

  // 🔑 THE FIX: Split to get the real batchId and Semester
  const [batchId, semesterNum] = rawValue.split("|");
  
  const subjects = (await App.getSubjects()).filter(s => 
    String(s.batchId) === String(batchId) &&
    String(s.semester) === String(semesterNum) // 🔒 Precise Semester Match
  );

  if (subjects.length === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "No subjects for this batch";
    studentUploadSubjectSelect.appendChild(opt);
    return;
  }

  subjects.forEach(s => {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = `${s.name} [${s.type}]`;
    studentUploadSubjectSelect.appendChild(opt);
  });
}

// react when batch changes
  studentUploadBatchSelect.onchange = async () => {
   await loadSubjectsForStudentUpload();
};

// ==========================
// Student Manager Actions 
// ==========================

document.getElementById("loadStudentManagerBtn").onclick = async function () {

  const rawValue = document.getElementById("studentManagerBatchSelect").value;
  const subjectId = document.getElementById("studentManagerSubjectSelect").value;
  const output = document.getElementById("studentManagerOutput");

  output.innerHTML = "";

  if (!rawValue || !subjectId) {
    UI.alert("Select batch and subject first");
    return;
  }

  const [batchId] = rawValue.split("|");

  const enrollments = await App.getEnrollments();
  const students = await App.getStudents();
  const batches = await App.getBatches();

  // ✅ ONLY current enrolled students (no historyIndex anymore)
  const currentIds = (enrollments[String(subjectId)] || []).map(String);
  const finalStudentIds = currentIds;

  if (finalStudentIds.length === 0) {
    output.textContent = "No students found.";
    return;
  }
  const ul = document.createElement("ul");

  finalStudentIds.forEach((sid, index) => {
    const st = students.find(s => String(s.id) === String(sid));
    if (!st) return;
    const studentBatch = batches.find(b => String(b.id) === String(st.batchId));
    const prog = studentBatch ? studentBatch.program : "UG"; 

    const li = document.createElement("li");
    li.style.padding = "10px";
    li.style.borderBottom = "1px solid #eee";
    li.style.display = "flex";
    li.style.alignItems = "center";

    const status = st.status || "ACTIVE";
    const statusColor = status === "ACTIVE" ? "green" : (status === "GRADUATED" ? "blue" : "red");
    
    const text = document.createElement("span");
    text.innerHTML = `${index + 1}. <b>${App.esc(st.roll)}</b> - ${App.esc(st.name)} <span style="color:${statusColor}">[${App.esc(status)}]</span>`;
    li.appendChild(text);
    if (status === "ACTIVE") {
      const deleteBtn = document.createElement("button");
      deleteBtn.innerHTML = "🗑️ Delete"; 
      deleteBtn.style.marginLeft = "15px";
      deleteBtn.style.background = "#95a5a6"; 
      deleteBtn.style.color = "white";
      deleteBtn.style.border = "none";
      deleteBtn.style.borderRadius = "4px";
      deleteBtn.style.padding = "4px 8px";

      deleteBtn.onclick = async () => {
        let hasRealHistory = false;
        try {
          // Check every subject this student is enrolled in, not just this one
          const allEnrollments = await App.getEnrollments();
          const theirSubjects = Object.keys(allEnrollments).filter(sid =>
            (allEnrollments[sid] || []).map(String).includes(String(st.id))
          );
          if (!theirSubjects.includes(String(subjectId))) theirSubjects.push(String(subjectId));

          for (const sid of theirSubjects) {
            const byDate = await App.getAttendanceForSubject(sid);
            if (Object.values(byDate).some(rec => rec[String(st.id)])) {
              hasRealHistory = true;
              break;
            }
          }
        } catch (e) {
          console.error("History check failed", e);
          UI.alert("Could not verify attendance history (network problem). Nothing was deleted.");
          return;
        }

        if (hasRealHistory) {
          UI.alert(`ACADEMIC LOCK: ${st.name} has attendance records. You cannot delete them. Use the Exit button instead.`);
        } else {
          if (await UI.confirm(`Delete the mistaken entry for ${st.name}?`, { title: "Delete student?", okText: "Delete", danger: true })) {

        const success = await App.deleteStudentFromFirestore(st.id);
        if (success && st.uid) await App.Accounts.removeLogin(st.uid, st.loginId).catch(e => console.warn(e));

        if (!success) {
        UI.alert("Delete failed. Check console.");
        return;
        }

        document.getElementById("loadStudentManagerBtn").click();
       }
        }
      };
      li.appendChild(deleteBtn);
      }

    // 🎓 2. THE IG/UG DIFFERENTIATOR
    if (status === "ACTIVE") {
      const exitBtn = document.createElement("button");
      
      // ✅ Assigning unique labels and colors based on program
      if (prog === "IG") {
        exitBtn.textContent = "📜 IG: Degree Completion";
        exitBtn.style.background = "#2980b9"; // Blue for Integrated
      } else if (prog === "PG") {
        exitBtn.textContent = "🎓 PG: Degree Completion";
        exitBtn.style.background = "#8e44ad"; // Purple for PG
      } else {
        exitBtn.textContent = "🎓 UG: Process Graduation";
        exitBtn.style.background = "#e67e22"; // Orange for UG
      }

      exitBtn.style.marginLeft = "15px";
      exitBtn.style.color = "white";
      exitBtn.style.border = "none";
      exitBtn.style.padding = "4px 8px";
      exitBtn.style.borderRadius = "4px";

      exitBtn.onclick = async () => {
        // ⚖️ DIFFERENTIATED PATHWAYS (values "1"/"2"/"3" are used below)
        const pathways = prog === "IG"
          ? [{ label: "🎓 Complete IG-10 (Graduation + PG)", value: "1" }, { label: "↩︎ Midway Exit (Dropped)", value: "2" }]
          : prog === "PG"
          ? [{ label: "🎓 Complete Masters Degree", value: "1" }, { label: "↩︎ Midway Exit (Dropped)", value: "2" }]
          : [{ label: "🎓 3-Year Degree", value: "1" }, { label: "🎓 4-Year Honours", value: "2" }, { label: "↩︎ Midway Exit (Dropped)", value: "3" }];

        const choice = await UI.choose(`Choose the exit pathway for ${st.name} (${prog}):`, pathways,
                                       { title: "Student exit" });
        let finalStatus = "GRADUATED";
        let exitReason = "";

        if (prog === "IG") {
          if (choice === "1") exitReason = "IG-10 (Grad+PG)";
          else if (choice === "2") { finalStatus = "DROPPED"; exitReason = "Midway Exit"; }
          else return;
        } else if (prog === "PG") {
          if (choice === "1") exitReason = "Masters Degree";
          else if (choice === "2") { finalStatus = "DROPPED"; exitReason = "Midway Exit"; }
          else return;
        } else {
          if (choice === "1") exitReason = "3-Year Degree";
          else if (choice === "2") exitReason = "4-Year Honours";
          else if (choice === "3") { finalStatus = "DROPPED"; exitReason = "Midway Exit"; }
          else return;
        }

        if (await UI.confirm(`Confirm ${st.name} as ${finalStatus} (${exitReason})?`)) {
          st.status = finalStatus;
          st.exitType = exitReason;
          st.exitDate = new Date().toLocaleDateString();
          const saved = await App.saveStudentToFirestore(st);
          if (!saved) {
            UI.alert("Save failed. Check your internet connection and try again.");
            return;
          }
          App.updateHODStats(); 
          document.getElementById("loadStudentManagerBtn").click(); 
        }
      };
      li.appendChild(exitBtn);
    }
    ul.appendChild(li);
  });
  output.appendChild(ul);
};

// ==========================
// Manual Add Student (Within Student Manager)
// ==========================

  document.getElementById("addManualStudentBtn").onclick = async function () {
  const nameInput = document.getElementById("manualStudentName");
  const rollInput = document.getElementById("manualStudentRoll");
  const status = document.getElementById("manualStudentStatus");
  
  // 🔑 THE FIX: Use the decoder here so the student search works!
  const rawValue = document.getElementById("studentManagerBatchSelect").value;
  const decoded = App.decodeBatchKey(rawValue);
  
  if (!decoded) {
    UI.alert("Select batch and subject first");
    return;
  }

  const batchId = decoded.id; // Now it correctly gets just the ID (e.g., 12345)
  const subjectId = document.getElementById("studentManagerSubjectSelect").value;
  // ... rest of the code is fine ...

  const name = nameInput.value.trim();
  const roll = rollInput.value.trim();

  if (!batchId || !subjectId) {
    UI.alert("Select batch and subject first");
    return;
  }

  if (!name || !roll) {
    UI.alert("Enter name and roll number");
    return;
  }



  let students = await App.getStudents();
  let enrollments = await App.getEnrollments();
  const subjects = await App.getSubjects();

  // 1. Find or Create the Student in the Batch "Master Stock"
  let student = students.find(s => 
    String(s.roll).trim() === roll && 
    String(s.batchId) === String(batchId)
  );

  if (!student) {
    student = {
      id: Date.now() + Math.random(),
      name,
      roll,
      batchId,
      status: "ACTIVE"
    };
    try {
  await App.saveStudentToFirestore(student);
} catch (e) {
  console.warn("Firestore student mirror failed", e);
}
    students.push(student);
  }

  // 2. Which subjects should this student join? (rules: App.syncTerritory)
  const currentSub = subjects.find(s => String(s.id) === String(subjectId));
  const batchesNow = await App.getBatches();
  const touched = currentSub
    ? App.syncTerritory(currentSub, subjects, batchesNow).map(s => String(s.id))
    : [String(subjectId)];
  if (!touched.includes(String(subjectId))) touched.push(String(subjectId));

  touched.forEach(sid => {
    if (!enrollments[sid]) enrollments[sid] = [];
    if (!enrollments[sid].map(String).includes(String(student.id))) {
      enrollments[sid].push(student.id);
    }
  });

  try {
    await App.commitWrites(touched.map(sid => ({
      collection: "enrollments",
      id: sid,
      data: { subjectId: sid, students: enrollments[sid] || [] }
    })));
  } catch (e) {
    console.error(e);
    status.textContent = "Save failed. Check your internet connection and try again.";
    status.style.color = "red";
    return;
  }
  status.textContent= "Student synchronized across territory.";
  status.style.color = "green";
  nameInput.value = "";
  rollInput.value = "";
  document.getElementById("loadStudentManagerBtn").click();
};


// ==========================
// Excel Upload (Students) - FIXED PROPAGATION & AUTO-REFRESH
// ==========================
uploadExcelBtn.onclick = () => {
  const file = excelInput.files[0]; 
  const batchId = studentUploadBatchSelect.value;
  const subjectId = studentUploadSubjectSelect.value;

  if (!file) {
    UI.alert("Select an Excel file");
    return;
  }

  if (!batchId || !subjectId) {
    UI.alert("Select batch and subject");
    return;
  }

  const reader = new FileReader();
  reader.onload = async function (e) {
    const data = new Uint8Array(e.target.result);
    const workbook = XLSX.read(data, { type: "array" });
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const jsonData = XLSX.utils.sheet_to_json(sheet);

    if (!jsonData.length) {
      UI.alert("Excel is empty");
      return;
    }

    // 🔑 THE REPAIR: Extract the clean numeric ID immediately
    const decoded = App.decodeBatchKey(batchId);
    const cleanBatchId = decoded ? decoded.id : batchId;

    let students = await App.getStudents();
    let enrollments = await App.getEnrollments();
    const newStudents = [];                       // students to create in Firestore
    const touchedSubjects = new Set([String(subjectId)]); // enrollments to save

    if (!enrollments[String(subjectId)]) {
      enrollments[String(subjectId)] = [];
    }

    // --------------------------
    // 1. Create students + enroll using the CLEAN ID
    // --------------------------
    jsonData.forEach(row => {
      const name = String(row.name || row.Name || "").trim();
      const roll = String(row.roll || row.Roll || "").trim();

      if (!name || !roll) return;

      // ✅ BATCH-AWARE SEARCH (Matches existing master records using clean ID)
      let student = students.find(st => 
        String(st.roll).trim() === roll && 
        String(st.batchId) === String(cleanBatchId)
      );

      if (!student) {
        student = {
          id: Date.now() + Math.random(),
          name,
          roll,
          batchId: cleanBatchId, // 🔒 Store only the clean numeric ID
          status: "ACTIVE"
        };
        students.push(student);
        newStudents.push(student);
      }

      if (!enrollments[String(subjectId)].includes(student.id)) {
        enrollments[String(subjectId)].push(student.id);
      }
    });
              // ==========================
// 🔁 UNIFIED TERRITORIAL SYNC (Fixed for UG/IG/PG)
// ==========================

const allSubjects = await App.getSubjects();   // load once
const uploadedSubject = allSubjects.find(
  s => String(s.id) === String(subjectId)
);

if (uploadedSubject) {
  // Rules live in App.syncTerritory (PG: all subjects; UG/IG: same type) — this semester onward
  const territorySubjects = App.syncTerritory(uploadedSubject, allSubjects, await App.getBatches());

      territorySubjects.forEach(relSub => {
        const sid = String(relSub.id);
        if (!enrollments[sid]) enrollments[sid] = [];
        touchedSubjects.add(sid);

        jsonData.forEach(row => {
          const roll = String(row.roll || row.Roll || "").trim();
          const foundSt = students.find(st =>
            String(st.roll).trim() === roll &&
            String(st.batchId) === String(cleanBatchId)
          );

          if (foundSt && !enrollments[sid].map(String).includes(String(foundSt.id))) {
            enrollments[sid].push(foundSt.id);
          }
        });
      });
    }

    // --------------------------
    // ✅ SAVE EVERYTHING AT THE END
    // --------------------------
    uploadStatus.textContent = "Saving... please wait.";
    uploadStatus.style.color = "#555";
    try {
      const writes = [
        ...newStudents.map(st => ({ collection: "students", id: st.id, data: st })),
        ...[...touchedSubjects].map(sid => ({
          collection: "enrollments",
          id: sid,
          data: { subjectId: sid, students: enrollments[sid] || [] }
        }))
      ];
      await App.commitWrites(writes);
    } catch (e) {
      console.error(e);
      uploadStatus.textContent = "Upload FAILED. Nothing may have been saved. Check your internet and try again.";
      uploadStatus.style.color = "red";
      return;
    }
    uploadStatus.textContent = `Upload successful! ${newStudents.length} new student(s) added, ${touchedSubjects.size} subject(s) updated.`;
    uploadStatus.style.color = "green";

    loadSubjectsForStudentUpload(); 
    loadBatchesForStudentUpload(); 
    }; 

    reader.readAsArrayBuffer(file);
    };

// ==========================
// INITIAL LOAD
// ==========================
// Run data migrations first
async function initApp() {
await renderBatches();
await loadBatchesIntoSubjectSelect();
await renderSubjects();
await renderTeachers();
await loadTeachersIntoAssignSelect();
await renderTeacherAssignments();
await loadBatchesForStudentManager();
await loadBatchesForStudentUpload();
await loadSubjectsForStudentUpload();
await loadSubjectsIntoAssignSelect();
}

  // ==========================
  // 🏛️ Digital Archive Search Engine
  // ==========================

const archiveYearFilter = document.getElementById("archiveYearFilter");
const archiveProgramFilter = document.getElementById("archiveProgramFilter");
const archiveSearchBtn = document.getElementById("archiveSearchBtn");
const archiveResults = document.getElementById("archiveResults");

  async function loadArchiveYearFilters() {
  if (!archiveYearFilter) return;

  const batches = await App.getBatches();
  
  // 🛰️ Get all unique years from your real data
  const years = [...new Set(batches.map(b => String(b.year)))];
  
  // Sort years (newest first for HOD convenience)
  years.sort((a, b) => b - a);

  // 🏗️ Rebuild the dropdown options
  let html = '<option value="all">All Years</option>';
  years.forEach(y => {
    html += `<option value="${y}">${y}</option>`;
  });
  
  archiveYearFilter.innerHTML = html;
}

  // ✅ NEW VERSION (Surgical Fix)

  let archiveSearchTriggered = false; // 🔒 The "Gatekeeper" variable
  async function renderArchive() {
  // 🛡️ If the search hasn't been clicked, do absolutely nothing
  if (!archiveSearchTriggered) return; 
  const selectedYear = archiveYearFilter.value;
  const selectedProgram = archiveProgramFilter.value;
  const batches = await App.getBatches();
  const subjects = await App.getSubjects();
  const teachers = await App.getTeachersFromFirestore();
  const subjectTeacherMap = await App.getSubjectAssignmentsFromFirestore();

  archiveResults.innerHTML = "";
  

  const filteredBatches = batches.filter(b => 
    b.status === 'ARCHIVED' && 
    (selectedYear === "all" || String(b.year) === selectedYear) &&
    (selectedProgram === "all" || b.program === selectedProgram)
  );

  if (filteredBatches.length === 0) {
    archiveResults.innerHTML = "<p style='color:#666;'>No archived records found for these filters.</p>";
    return;
  }

    filteredBatches.forEach(b => {
    const section = document.createElement("div");
    section.style.border = "1px solid #ccc";
    section.style.padding = "10px";
    section.style.marginBottom = "10px";
    section.style.background = "#f9f9f9";

    section.innerHTML = `<h4>${App.esc(b.program)} Batch ${App.esc(b.year)} - Sem ${App.esc(b.semester)} (ARCHIVED)</h4>`;
    const lastArchived = (b.statusHistory || []).filter(h => h.status === "ARCHIVED").pop();
    if (lastArchived) {
      section.innerHTML += `<div style="font-size:12px; color:#6b7280;">Archived on ${new Date(lastArchived.at).toLocaleString()} by ${App.esc(lastArchived.by)}</div>`;
    }
    const restoreBtn = document.createElement("button");
    restoreBtn.textContent = "↩︎ Restore this semester";
    restoreBtn.style.margin = "6px 0";
    restoreBtn.onclick = async () => {
      if (!await UI.confirm(`Restore ${b.program} Batch ${b.year} – Semester ${b.semester} from the archive?\n\n` +
                   `It will go back to Admin Panel → Batch / Semester Manager as CLOSED (read-only). ` +
                   `From there you can set it Active if attendance must be marked again.`)) return;
      restoreBtn.disabled = true;
      await App.setBatchStatus(b.id, b.semester, "CLOSED");
      UI.alert("Semester restored as CLOSED. You'll find it in Admin Panel → Batch / Semester Manager.");
      await renderArchive();
    };
    section.appendChild(restoreBtn);
    
    const subList = document.createElement("ul");
    
    // 🔑 THE FIX: Filter by BOTH Batch ID and the specific Semester
    const batchSubjects = subjects.filter(s => 
      String(s.batchId) === String(b.id) && 
      String(s.semester) === String(b.semester)
    );

  batchSubjects.forEach(s => {
  const tid = subjectTeacherMap[String(s.id)];
  const teacher = teachers.find(t => String(t.id) === String(tid));
  const teacherName = teacher ? teacher.name : "Unassigned";
  const teacherStatus = teacher?.status === "FORMER" ? " (Former Staff)" : "";

  const li = document.createElement("li");
  // 🔑 THE REPAIR: Trust the Subject's internal semester identity
  li.innerHTML = `<b>${App.esc(s.name)} (Sem ${App.esc(s.semester)})</b> — Taught by: ${App.esc(teacherName)}${teacherStatus}`;

  // ✅ NEW: create the button, then attach our placeholder onclick
  const viewBtn = document.createElement("button");
  viewBtn.textContent = "View Historical Register";
  viewBtn.style.marginLeft = "10px";

  viewBtn.onclick = () => App.Archive.showRegister(s, b);

  li.appendChild(viewBtn);   // ⬅️ attach button to the li
  subList.appendChild(li);
});


    section.appendChild(subList);
    archiveResults.appendChild(section);
  });
}

 if (archiveSearchBtn) {
    archiveSearchBtn.onclick = async () => {
      archiveSearchTriggered = true; 
      await renderArchive();
    };
  }

  // --- Student Exit & Alumni Registry Logic ---
  const loadExitRegistryBtn = document.getElementById("loadExitRegistryBtn");
  if (loadExitRegistryBtn) {
  loadExitRegistryBtn.onclick = async function() {
    const students = await App.getStudents() || [];
   const output = document.getElementById("exitRegistryOutput");
   if (!output) return;
    
    // Filter for anyone who is NOT active (Graduated or Dropped)
    const exited = students.filter(s => s.status && s.status !== "ACTIVE");
    
    if (exited.length === 0) {
      output.innerHTML = "<p style='color:#666; font-style:italic;'>No records in the exit registry yet. Graduate some students first!</p>";
      return;
    }

    // Build the "Macro Ledger" table
    let html = `
      <table border="1" style="width:100%; border-collapse:collapse; background:white; font-size:14px;">
        <thead style="background:#2c3e50; color:white;">
          <tr>
            <th style="padding:10px;">Name</th>
            <th style="padding:10px;">Roll</th>
            <th style="padding:10px;">Status</th>
            <th style="padding:10px;">Exit Pathway</th>
            <th style="padding:10px;">Exit Date</th>
          </tr>
        </thead>
        <tbody>`;
    
    exited.forEach(s => {
      const statusColor = s.status === 'GRADUATED' ? '#2980b9' : '#c0392b';
      html += `
        <tr>
          <td style="padding:8px; border:1px solid #ddd;">${App.esc(s.name)}</td>
          <td style="padding:8px; border:1px solid #ddd;">${App.esc(s.roll)}</td>
          <td style="padding:8px; border:1px solid #ddd; color:${statusColor}; font-weight:bold;">${App.esc(s.status)}</td>
          <td style="padding:8px; border:1px solid #ddd;">${App.esc(s.exitType || "N/A")}</td>
          <td style="padding:8px; border:1px solid #ddd;">${App.esc(s.exitDate || "N/A")}</td>
        </tr>`;
    });
html += "</tbody></table>";
    output.innerHTML = html;
      }; // 🟢 Only ONE bracket here to close the button click.
  }


// ==========================
// Attendance Module (FINAL — STABLE, EXPLICIT LOAD, NO AUTO RESET)
// ==========================

  App.Attendance = {};
  App.Attendance.init = async function () {
  const subjectSelect = document.getElementById("subjectSelect");
  const studentList = document.getElementById("student-list");
  const dateInput = document.getElementById("attendanceDate");
  const saveBtn = document.getElementById("saveBtn");
  const saveStatus = document.getElementById("saveStatus");
  const saveBar = document.getElementById("attendanceSaveBar");
  const countBox = document.getElementById("attendanceCountBox");
  const topBar = document.getElementById("attendanceTopBar");
  const viewOnlyBtn = document.getElementById("viewOnlyBtn");
  if (!subjectSelect || !studentList || !dateInput || !saveBtn || !saveBar || !countBox || !topBar) return;

  const user = Auth.currentUser();
  const isTeacher = !!user && user.role === "Teacher";
  let uiLoaded = false;   // Save works only after a class list was shown
  let loadSeq = 0;        // only the latest load may draw (subject/date can change quickly)

  // Reset the screen each time it opens
  dateInput.value = "";
  studentList.innerHTML = "";
  topBar.innerHTML = "";
  saveStatus.textContent = "";
  saveBar.style.display = "none";

  // --------------------------
  // Load Subjects
  // --------------------------
  async function loadSubjects() {
    const subjects = await App.getSubjects();
    const batches = await App.getBatches();
    const enrollments = await App.getEnrollments();

    subjectSelect.innerHTML = `<option value="">-- Select Subject --</option>`;
    let allowed = subjects;

    if (isTeacher) {
      const map = await App.getSubjectAssignmentsFromFirestore();
      allowed = subjects.filter(s => {
        const isAssigned = String(map[String(s.id)]) === String(user.id);
        const batch = batches.find(b => String(b.id) === String(s.batchId) && String(b.semester) === String(s.semester));
        // RULE: Hide ARCHIVED subjects from daily operational screens
        return isAssigned && batch && batch.status !== "ARCHIVED";
      });
    }

    if (user && user.role === "Student") {
      const myId = String(user.studentId);
      allowed = subjects.filter(s => (enrollments[String(s.id)] || []).map(String).includes(myId));
    }

    allowed.forEach(sub => {
      const batch = batches.find(b => String(b.id) === String(sub.batchId) && String(b.semester) === String(sub.semester));
      const batchText = batch ? `${batch.program} Batch ${batch.year} Sem ${batch.semester}` : "Unknown Batch";
      const opt = document.createElement("option");
      opt.value = sub.id;
      opt.textContent = `${sub.name} (${sub.type} | ${batchText})`;
      subjectSelect.appendChild(opt);
    });
  }

  // --------------------------
  // Counts and row status
  // --------------------------
  function updateCount() {
    let p = 0, a = 0, l = 0;
    studentList.querySelectorAll("#attendanceTable tbody tr").forEach(tr => {
      const s = tr.dataset.status;
      if (s === "Absent") a++; else if (s === "Leave") l++; else if (s === "Present") p++;
    });
    countBox.textContent = `Present: ${p} | Absent: ${a}` + (l ? ` | Leave: ${l}` : "");
  }

  // Show a status in the table (Present / Absent / Leave (type) / —)
  function setStatus(tr, status, leaveType) {
    tr.dataset.status = status;
    if (leaveType) tr.dataset.leaveType = leaveType; else delete tr.dataset.leaveType;
    if (status !== "Leave") delete tr.dataset.leaveRef;
    tr.classList.toggle("is-absent", status === "Absent");
    tr.classList.toggle("is-leave", status === "Leave");
    const cell = tr.querySelector(".status");
    cell.textContent = status === "Leave" ? `Leave (${App.LEAVE_TYPES[leaveType] || "?"})` : status;
    cell.style.color = status === "Absent" ? "#b91c1c" : status === "Leave" ? "#1d4ed8" : status === "Present" ? "green" : "#6b7280";
  }

  function showMessage(text) {
    studentList.innerHTML = `<p>${App.esc(text)}</p>`;
    saveBar.style.display = "none";
  }

  // --------------------------
  // Load Students
  // --------------------------
  async function loadStudents() {
    const my = ++loadSeq;
    const stale = () => my !== loadSeq;
    const subjectId = subjectSelect.value;
    const date = dateInput.value;

    topBar.innerHTML = "";
    saveStatus.textContent = "";
    uiLoaded = false;
    if (!subjectId || !date) { showMessage(""); return; }
    studentList.innerHTML = "<p>Loading…</p>";
    saveBar.style.display = "none";

    const subject = (await App.getSubjects()).find(s => String(s.id) === subjectId);
    if (stale()) return;
    if (!subject) { showMessage("Subject not found."); return; }

    if (!(await App.isBatchOpen(subject.batchId, subject.semester))) { if (!stale()) showMessage("Semester is closed."); return; }
    if (await App.isClosedDay(date)) { if (!stale()) showMessage("Day is closed."); return; }
    if (stale()) return;
    if (date > new Date().toLocaleDateString("en-CA")) { showMessage("Attendance can't be marked for a future date."); return; }

    const cancellation = await App.getClassCancellation(subjectId, date);
    if (stale()) return;
    if (cancellation) { showMessage("Class not held."); return; }

    const [enrollments, students, record] = await Promise.all([
      App.getEnrollments(), App.getStudents(), App.getAttendance(subjectId, date)
    ]);
    App.clearAttendanceCaches();
    const subjData = await App.loadSubjectData(subjectId);     // corrections, leaves, casual counts
    const leaveLimit = await App.getLeaveLimit();
    if (stale()) return;

    const ids = (enrollments[String(subjectId)] || [])
      .map(id => students.find(s => String(s.id) === String(id)))
      .filter(Boolean)
      .filter(st => !st.status || st.status === "ACTIVE")
      .sort(App.sortByRoll);     // 1, 2, … 10 (same order as the register)
    const saved = Object.keys(record || {}).length > 0;
    const marking = isTeacher && !saved;
    uiLoaded = true;

    // Rarely needed, so kept quiet; only before attendance is saved
    if (isTeacher && !saved) {
      const btn = document.createElement("button");
      btn.className = "quiet-danger";
      btn.textContent = "Mark Class Not Held";
      btn.onclick = async () => {
        const reason = await UI.prompt("Reason for class not held:");
        if (!reason) return;
        const cancelled = await App.cancelClass({ subjectId, date, teacherId: String(user.id), reason });
        UI.alert(cancelled ? "Class marked as not held." : "Could NOT save. Check your internet connection and try again.");
        await loadStudents();
      };
      topBar.appendChild(btn);
    }

    studentList.innerHTML = `
      ${marking ? `<div class="attendance-tools">
          <button type="button" id="allPresentBtn">All present</button>
          <button type="button" id="allAbsentBtn">All absent</button>
          <span class="attendance-hint">Tap a student to mark absent; tap again to undo.</span>
        </div>` : ""}
      <table id="attendanceTable" class="${marking ? "marking" : ""}" border="1" cellpadding="6"
        style="border-collapse:collapse;width:100%;">
        <thead style="background:#eee;">
          <tr><th>S.No</th><th>Roll</th><th>Name</th><th>Status</th><th>Action</th></tr>
        </thead>
        <tbody></tbody>
      </table>`;
    const tbody = studentList.querySelector("#attendanceTable tbody");

    ids.forEach((st, i) => {
      const tr = document.createElement("tr");
      tr.dataset.studentId = st.id;
      tr.innerHTML = `
        <td>${i + 1}</td>
        <td>${App.esc(st.roll)}</td>
        <td>${App.esc(st.name)}</td>
        <td class="status" style="font-weight:bold;"></td>
        <td></td>`;
      const hasEntry = saved && record[String(st.id)] !== undefined;
      if (!saved) setStatus(tr, "Present");
      else if (!hasEntry) setStatus(tr, "—");
      else {
        const eff = subjData.effective(date, st.id) || App.normalizeStatus(record[String(st.id)]) || "—";
        const lv = eff === "Leave" ? subjData.leaveOf(date, st.id) : null;
        setStatus(tr, eff, lv ? lv.type : null);
      }
      const action = tr.lastElementChild;

      if (marking) {
        // Tap the row: Present <-> Absent (a leave goes back to Present)
        tr.onclick = () => {
          setStatus(tr, tr.dataset.status === "Present" ? "Absent" : "Present");
          updateCount();
        };
        const lbtn = document.createElement("button");
        lbtn.type = "button";
        lbtn.textContent = "Leave…";
        lbtn.onclick = async e => {
          e.stopPropagation();
          const lv = await App.askLeaveDetails(st.name, subjData.casualUsed(st.id), leaveLimit);
          if (lv) { setStatus(tr, "Leave", lv.type); tr.dataset.leaveRef = lv.reference; }
          updateCount();
        };
        action.appendChild(lbtn);
      } else if (hasEntry && isTeacher) {
        // Absent after saving? The approved leave form can be recorded now.
        if (tr.dataset.status === "Absent") {
          const lbtn = document.createElement("button");
          lbtn.textContent = "Mark Leave";
          lbtn.onclick = async () => {
            const lv = await App.askLeaveDetails(st.name, subjData.casualUsed(st.id), leaveLimit);
            if (!lv) return;
            try {
              await App.saveLeave({ subjectId, date, studentId: st.id, type: lv.type, reference: lv.reference });
              await UI.alert(`Leave (${App.LEAVE_TYPES[lv.type]}) recorded for ${st.name} on ${date}.`);
            } catch (e) {
              console.error(e);
              await UI.alert("Leave could NOT be saved. Check your internet connection and try again.");
            }
            await loadStudents();
          };
          action.appendChild(lbtn);
        }
        const btn = document.createElement("button");
        btn.textContent = "Request Correction";
        btn.onclick = async () => {
          const current = tr.dataset.status === "Leave" ? "Absent" : App.normalizeStatus(tr.dataset.status);
          const wanted = current === "Present" ? "Absent" : "Present";
          if (!await UI.confirm(`${st.name} is marked ${current || "?"} on ${date}.\n\nRequest HOD to change it to ${wanted}?`)) return;
          const r = await UI.prompt("Reason for correction:");
          if (!r || !r.trim()) return;
          const ok = await App.requestAttendanceCorrection({
            subjectId, date, studentId: st.id, requestedStatus: wanted, reason: r.trim()
          });
          UI.alert(ok ? "Request sent to HOD." : "Request could not be sent. Check your connection and try again.");
        };
        action.appendChild(btn);
      }
      tbody.appendChild(tr);
    });

    // All present / All absent (students on leave keep their leave)
    const setAll = status => {
      tbody.querySelectorAll("tr").forEach(tr => { if (tr.dataset.status !== "Leave") setStatus(tr, status); });
      updateCount();
    };
    const allP = document.getElementById("allPresentBtn"), allA = document.getElementById("allAbsentBtn");
    if (allP) allP.onclick = () => setAll("Present");
    if (allA) allA.onclick = () => setAll("Absent");

    // Bottom bar: counts + Save (teacher, not yet saved) / saved note / HOD view-only
    updateCount();
    saveBar.classList.toggle("saved", saved);
    saveBtn.style.display = marking ? "" : "none";
    saveBtn.disabled = !marking;
    if (viewOnlyBtn) viewOnlyBtn.style.display = user && user.role === "HOD" ? "inline-block" : "none";
    if (saved && isTeacher) saveStatus.textContent = "✅ Saved. Changes go through Request Correction.";
    saveBar.style.display = "";
  }

  // --------------------------
  // Save Attendance
  // --------------------------
  async function saveAttendance() {
    if (!uiLoaded) return;

    const records = {};
    const leavesToSave = [];
    studentList.querySelectorAll("#attendanceTable tbody tr").forEach(tr => {
      const s = tr.dataset.status;
      // A leave is recorded as an absence plus a separate leave record
      records[tr.dataset.studentId] = s === "Leave" ? "Absent" : s;
      if (s === "Leave") leavesToSave.push({ studentId: tr.dataset.studentId, type: tr.dataset.leaveType, reference: tr.dataset.leaveRef || "" });
    });
    const attendanceRecord = {
      subjectId: String(subjectSelect.value),
      date: dateInput.value,
      records: records,
      timestamp: Date.now(),
      markedBy: String(Auth.currentUser().id || ""),
      markedAt: new Date().toISOString()
    };

    saveBtn.disabled = true;
    saveStatus.textContent = "Saving…";
    const saved = await App.saveAttendanceToFirestore(attendanceRecord);
    if (!saved.ok) {
      saveStatus.textContent = "NOT saved.";
      await UI.alert("Attendance was NOT saved.\n\nCheck your internet connection and try again. " +
            "(If attendance for this class and date was already saved, it cannot be saved again — use Request Correction.)\n\n" +
            "Attendance also can't be saved for a Sunday, a day the HOD closed, a class marked not held, " +
            "a future date, or a semester that is not active.");
      await loadStudents();
      return;
    }

    // Leaves are saved after the attendance itself (each needs the saved attendance)
    const leaveProblems = [];
    for (const lv of leavesToSave) {
      try {
        await App.saveLeave({ subjectId: attendanceRecord.subjectId, date: attendanceRecord.date, studentId: lv.studentId, type: lv.type, reference: lv.reference });
      } catch (e) {
        console.error(e);
        leaveProblems.push(lv.studentId);
      }
    }

    await UI.alert("Attendance saved successfully.\n" + countBox.textContent +
      (leaveProblems.length ? `\n\n⚠️ ${leaveProblems.length} leave(s) could not be saved — those students show as Absent. Use "Mark Leave" to add them.` : "") +
      (saved.copiesMissing ? `\n\n⚠️ ${saved.copiesMissing} student(s) won't see this day on their dashboard yet. Ask the HOD to use "Rebuild student copies" (Admin Panel → Settings).` : ""));
    await loadStudents();
  }

  await loadSubjects();
  subjectSelect.onchange = loadStudents;
  dateInput.onchange = loadStudents;
  saveBtn.onclick = saveAttendance;
  };




// ==========================
// Cancelled Classes Log (HOD)
// ==========================

  App.CancelledClasses = {};

  App.CancelledClasses.init = async function () {
  const container = document.getElementById("cancelledClassesLog");
  if (!container) return;

  const user = Auth.currentUser();
  if (!user || user.role !== "HOD") {
    container.innerHTML = "<p>Access denied.</p>";
    return;
  }

  const cancelList = (await App.getAllClassCancellations())
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const subjects = await App.getSubjects();
  const teachers = await App.getTeachersFromFirestore();

  if (cancelList.length === 0) {
    container.innerHTML = "<p>No cancelled classes.</p>";
    return;
  }

  let html = `
    <table border="1" cellpadding="6" width="100%">
      <tr>
        <th>Date</th>
        <th>Subject</th>
        <th>Teacher</th>
        <th>Reason</th>
        <th>Marked At</th>
      </tr>
  `;

  cancelList.forEach(c => {
    const subject= subjects.find(s => String(s.id) === String(c.subjectId));
    const teacher = teachers.find(t => String(t.id) === String(c.teacherId));

    html += `
      <tr>
        <td>${App.esc(c.date)}</td>
        <td>${App.esc(subject ? subject.name : "Unknown")}</td>
        <td>${App.esc(teacher ? teacher.name : "Unknown")}</td>
        <td>${App.esc(c.reason)}</td>
        <td>${new Date(c.timestamp).toLocaleString()}</td>
      </tr>
    `;
  });

  html += "</table>";
  container.innerHTML = html;
};


// ==========================
// Reports Module (CORRECTION-AWARE + ROLE SAFE)
// ==========================

App.Reports = {};

App.Reports.init = async function () {
  const fromDateInput = document.getElementById("fromDate");
  const toDateInput = document.getElementById("toDate");
  // Always reset date fields when opening reports
  fromDateInput.value = "";
  toDateInput.value = "";
  const subjectFilter = document.getElementById("subjectFilter");
  const generateBtn = document.getElementById("generateBtn");
  const reportOutput = document.getElementById("reportOutput");
  const exportExcelBtn = document.getElementById("exportExcelBtn");
  const exportPdfBtn = document.getElementById("exportPdfBtn");

  if (!fromDateInput || !toDateInput || !subjectFilter || !generateBtn) return;

  async function getAllowedSubjects() {
    return await App.getVisibleSubjects();
  }

  async function loadSubjects() {
    await App.fillSubjectSelect(subjectFilter);
  }

    async function generateReport() {
    const from = fromDateInput.value;
    const to = toDateInput.value;
    const selectedSubject = subjectFilter.value;

    if (!from || !to) {
      UI.alert("Select date range");
      return;
    }
    if (from > to) {
      UI.alert("The 'From' date is after the 'To' date.");
      return;
    }

    reportOutput.innerHTML = "<p>Generating report…</p>";

    const user = Auth.currentUser();
    const allStudents = await App.getStudents();
    const subjects = await getAllowedSubjects();
    const batches = await App.getBatches();
    const enrollments = await App.getEnrollments();

    let output = `
  <h2 style="margin-bottom:10px;">Attendance Summary Report</h2>
  <div style="margin-bottom:15px; padding:10px; border:1px solid #ccc; background:#f8f9fa;">
    <b>From:</b> ${from} &nbsp;&nbsp;
    <b>To:</b> ${to}
  </div>
`;

    let foundAny = false;

    for (const subject of subjects) {
      if (selectedSubject !== "all" && String(subject.id) !== selectedSubject) continue;

      const data = await App.loadSubjectData(subject.id);
      const currentIds = (enrollments[String(subject.id)] || []).map(String);
      let ids = [...new Set([...currentIds, ...data.recordedStudentIds()])];
      if (user && user.role === "Student") ids = ids.filter(id => id === String(user.studentId));

      const students = ids
        .map(id => allStudents.find(s => String(s.id) === id))
        .filter(Boolean)
        .sort(App.sortByRoll);
      if (students.length === 0) continue;

      const held = data.heldDates(from, to).length;

      output += `
      <div style="margin-top:20px; padding:10px; border:2px solid #444; background:#fafafa; text-align:left;">
        <h3 style="margin-top:0; text-align:left;">${App.esc(App.subjectLabel(subject, batches))}</h3>
        <div style="margin-bottom:8px;">Classes held in this period: <b>${held}</b></div>
        <table border="1" cellpadding="5" width="100%" style="border-collapse:collapse; text-align:left;">
          <tr style="background:#eee;">
            <th style="text-align:left;">Student</th>
            <th style="text-align:center;">Present</th>
            <th style="text-align:center;">Absent</th>
            <th style="text-align:center;">Leave</th>
            <th style="text-align:center;">%</th>
          </tr>`;

      for (const st of students) {
        const t = data.tally(st.id, from, to);
        const isCurrent = currentIds.includes(String(st.id));
        const pct = t.percent === null ? "—" : t.percent + "%";
        const low = t.percent !== null && t.percent < 75;
        output += `
          <tr style="${low ? "background:#ffe0e0;" : ""}">
            <td style="text-align:left;">${App.esc(st.roll)} - ${App.esc(st.name)}${isCurrent ? "" : " (removed)"}</td>
            <td style="text-align:center;">${t.present}</td>
            <td style="text-align:center;">${t.absent}</td>
            <td style="text-align:center;">${t.leave}</td>
            <td style="text-align:center;">${pct}</td>
          </tr>`;
        foundAny = true;
      }

      output += `</table></div>`;
    }

    if (!foundAny) {
      output += `<p>No data found.</p>`;
    }

    reportOutput.innerHTML = output;
  }

  await loadSubjects();

  function showSummaryView() {
  const summary = document.getElementById("reportOutput");
  const register = document.getElementById("registerOutput");

  // Clear and hide register completely
  register.innerHTML = "";
  register.style.display = "none";

  // Show summary
  summary.style.display = "block";
}


function showRegisterView() {
  const summary = document.getElementById("reportOutput");
  const register = document.getElementById("registerOutput");

  // Clear and hide summary completely
  summary.innerHTML = "";
  summary.style.display = "none";

  // Show register
  register.style.display = "block";
}


// default view
showSummaryView();

generateBtn.onclick = async function () {
  const viewType = document.querySelector(
    'input[name="reportViewType"]:checked'
  )?.value || "summary";

  if (viewType === "register") {
    showRegisterView();
    document.getElementById("registerOutput").innerHTML = "";
    App.Reports.generateRegisterView();
  } else {
  showSummaryView();
  document.getElementById("reportOutput").innerHTML = "";
  await generateReport();
}
};

  if (exportExcelBtn) exportExcelBtn.onclick = exportToExcel;
  if (exportPdfBtn) exportPdfBtn.onclick = exportToPDF;

  // Quick date ranges: This month / Last month / Since first class
  const localDate = d => d.toLocaleDateString("en-CA");          // YYYY-MM-DD, local time
  document.querySelectorAll("#reportsSection .quick-dates button").forEach(btn => {
    btn.onclick = async () => {
      const now = new Date();
      const range = btn.dataset.range;
      if (range === "this-month") {
        fromDateInput.value = localDate(new Date(now.getFullYear(), now.getMonth(), 1));
        toDateInput.value = localDate(now);
      } else if (range === "last-month") {
        fromDateInput.value = localDate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
        toDateInput.value = localDate(new Date(now.getFullYear(), now.getMonth(), 0));
      } else {
        btn.disabled = true;
        try {
          const chosen = subjectFilter.value;
          const subjects = (await getAllowedSubjects()).filter(s => chosen === "all" || String(s.id) === chosen);
          let first = null;
          for (const sub of subjects) {
            const d = (await App.loadSubjectData(sub.id)).heldDates()[0];
            if (d && (!first || d < first)) first = d;
          }
          if (!first) { UI.alert("No classes have been recorded yet for the selected subject(s)."); return; }
          fromDateInput.value = first;
          toDateInput.value = localDate(now);
        } finally {
          btn.disabled = false;
        }
      }
    };
  });
};

// ==========================
// Register View (Classic) — HISTORY SAFE
// ==========================

App.Reports.generateRegisterView = async function () {
  const registerOutput = document.getElementById("registerOutput");
  const reportOutput = document.getElementById("reportOutput");

  reportOutput.innerHTML = "";
  registerOutput.innerHTML = "<p>Generating register view…</p>";

  const subjectId = document.getElementById("subjectFilter").value;
  if (!subjectId || subjectId === "all") {
    registerOutput.innerHTML = "<p>Please select a single subject.</p>";
    return;
  }

  const fromDate = document.getElementById("fromDate").value;
  const toDate = document.getElementById("toDate").value;

  if (!fromDate || !toDate) {
    registerOutput.innerHTML = "<p>Please select date range.</p>";
    return;
  }

  App.Reports._registerContext = {
    subjectId,
    fromDate,
    toDate
  };

  await App.Reports.renderRegisterGrid();
};

// ==========================
// Register Grid Renderer — HISTORY SAFE
// ==========================

  App.Reports.renderRegisterGrid = async function () {
  const ctx = App.Reports._registerContext;
  if (!ctx) return;

  const { subjectId, fromDate, toDate } = ctx;
  const registerOutput = document.getElementById("registerOutput");
  registerOutput.innerHTML = "";

  const subjects = await App.getSubjects();
  const subject = subjects.find(
  s => String(s.id) === String(subjectId)
  );
  if (!subject) return;

  // -------- Teacher name --------
 // -------- Teacher name --------
let teacherName = "—";
const subjectTeacherMap = await App.getSubjectAssignmentsFromFirestore();
const teachers = await App.getTeachersFromFirestore();

const tid = subjectTeacherMap[String(subjectId)];
if (tid) {
  const t = teachers.find(x => String(x.id) === String(tid));
  if (t) teacherName = t.name;
}
const teacherHistoryLine = App.teacherHistoryText((await App.getAssignmentHistories())[String(subjectId)], teachers, fromDate, toDate);


  // -------- Month / Year --------
  const monthYear = new Date(fromDate).toLocaleString("en-US", {
    month: "long",
    year: "numeric"
  });

  // -------- Students: currently enrolled + anyone with saved attendance --------
  const enrollments = await App.getEnrollments();
  const allStudents = await App.getStudents();
  const data = await App.loadSubjectData(subjectId);

  const currentIds = (enrollments[String(subjectId)] || []).map(String);
  const allStudentIds = [...new Set([...currentIds, ...data.recordedStudentIds()])];

  let students = allStudentIds
    .map(id => allStudents.find(s => String(s.id) === String(id)))
    .filter(Boolean)
    .sort(App.sortByRoll);

  const user = Auth.currentUser();
  if (user && user.role === "Student") {
    students = students.filter(st => String(st.id) === String(user.studentId));
  }

  if (students.length === 0) {
    registerOutput.innerHTML = "<p>No students (current or historical).</p>";
    return;
  }

  if (fromDate > toDate) {
    registerOutput.innerHTML = "<p>The 'From' date is after the 'To' date.</p>";
    return;
  }
  const dates = App.datesBetween(fromDate, toDate);

  // -------- Header --------
  const batches = await App.getBatches();
  const batchText = App.subjectLabel(subject, batches);

  let html = `
    <div style="margin-bottom:15px;">
      <h2 style="margin:0;">Attendance Register</h2>
      <div><b>Subject:</b> ${App.esc(batchText)}</div>
      <div><b>Teacher:</b> ${App.esc(teacherHistoryLine || teacherName)}</div>
      <div><b>Month:</b> ${monthYear}</div>
      <div><b>Period:</b> ${fromDate} to ${toDate}</div>
      <div><b>Classes held:</b> ${data.heldDates(fromDate, toDate).length}</div>
    </div>
  `;

  html += `<table border="1" cellpadding="4" style="border-collapse:collapse;width:100%;">`;
  html += `<tr><th>S. No.</th><th>Roll</th><th>Name</th>`;
  dates.forEach(d => html += `<th>${d.slice(8, 10)}</th>`);
  html += `<th>P</th><th>AB</th><th>L</th><th>%</th></tr>`;

  let anyCorrected = false, anyLeave = false;

  students.forEach((st, index) => {
    const isCurrent = currentIds.includes(String(st.id));
    html += `<tr>
      <td>${index + 1}</td>
      <td>${App.esc(st.roll)}</td>
      <td>${App.esc(st.name)}${isCurrent ? "" : " (removed)"}</td>`;

    for (const date of dates) {
      let cell = "—", bg = "", title = "";
      const closed = data.closedReason(date);
      if (closed && closed.type === "sunday") {
        cell = "SUN"; bg = "#e2e3e5";
      } else if (closed) {
        cell = "HOL"; bg = "#d1ecf1";
      } else if (data.isCancelled(date)) {
        cell = "CL"; bg = "#fff3cd";
      } else {
        const att = data.effective(date, st.id);
        const mark = data.isCorrected(date, st.id) ? "*" : "";
        if (mark) anyCorrected = true;
        if (att === "Present") { cell = "P" + mark; bg = "#d4edda"; }
        else if (att === "Absent") { cell = "AB" + mark; bg = "#f8d7da"; }
        else if (att === "Leave") {
          const lv = data.leaveOf(date, st.id);
          cell = "L" + mark; bg = "#dbeafe"; anyLeave = true;
          title = `Leave (${App.LEAVE_TYPES[lv && lv.type] || "?"})${lv && lv.reference ? " — " + lv.reference : ""}`;
        }
      }
      html += `<td style="text-align:center;background:${bg};"${title ? ` title="${App.esc(title)}"` : ""}>${cell}</td>`;
    }

    const t = data.tally(st.id, fromDate, toDate);
    html += `<td><b>${t.present}</b></td><td><b>${t.absent}</b></td><td><b>${t.leave}</b></td>
             <td><b>${t.percent === null ? "—" : t.percent + "%"}</b></td></tr>`;
  });

  // "Marked by" row: who marked each day
  const markers = {};
  html += `<tr style="background:#f8fafc;"><td></td><td></td><td style="text-align:left;"><i>Marked by</i></td>`;
  for (const date of dates) {
    const id = data.markedBy(date);
    const t = id ? teachers.find(x => String(x.id) === id) : null;
    const ini = t ? App.initials(t.name) : (id ? "?" : "");
    if (t) markers[ini] = t.name;
    html += `<td style="text-align:center; font-size:10px;"${t ? ` title="${App.esc(t.name)}"` : ""}>${App.esc(ini)}</td>`;
  }
  html += `<td colspan="4"></td></tr>`;

  html += `</table>
    <div style="margin-top:15px;">
      <b>Legend:</b><br>
      P = Present &nbsp;|&nbsp;
      AB = Absent &nbsp;|&nbsp;
      SUN = Sunday &nbsp;|&nbsp;
      HOL = HOD Closure &nbsp;|&nbsp;
      CL = Class Not Held
      ${anyLeave ? "&nbsp;|&nbsp; L = Leave (not counted in %; hover to see the type)" : ""}
      ${anyCorrected ? "&nbsp;|&nbsp; * = corrected (approved by HOD)" : ""}
      ${Object.keys(markers).length ? "<br><b>Marked by:</b> " + Object.entries(markers).map(([k, v]) => `${App.esc(k)} = ${App.esc(v)}`).join(" &nbsp;|&nbsp; ") : ""}
    </div>
  `;

  registerOutput.innerHTML = html;
};

// ==========================
// Student Dashboard Module — HISTORY SAFE
// ==========================

App.Student = {};

App.Student.init = async function () {
  const user = Auth.currentUser();
  if (!user || user.role !== "Student") return;

  const infoBox = document.getElementById("studentInfoBox");
  const output = document.getElementById("studentDashboardOutput");
  if (!infoBox || !output) return;

  output.innerHTML = "<p>Loading your attendance…</p>";

  try {
    const batches = await App.getBatches();
    const meSnap = await db.collection("students").doc(String(user.studentDocId)).get();
    const me = meSnap.exists ? meSnap.data() : null;
    if (!me) {
      output.innerHTML = "<p>Your record could not be found. Please contact the department.</p>";
      return;
    }

    infoBox.innerHTML = `<b>Name:</b> ${App.esc(me.name)} <br> <b>Roll:</b> ${App.esc(me.roll)}`;

    const mySubjects = await App.getVisibleSubjects();   // only subjects I'm enrolled in
    if (mySubjects.length === 0) {
      output.innerHTML = "<p>You are not enrolled in any subjects yet.</p>";
      return;
    }

    // Group subjects by semester (newest batch/semester first)
    const groups = {};
    for (const sub of mySubjects) {
      const batch = batches.find(b => String(b.id) === String(sub.batchId) &&
                                      String(b.semester) === String(sub.semester));
      const key = `${sub.program} Semester ${sub.semester} (Batch ${sub.year})`;
      if (!groups[key]) groups[key] = { status: batch ? batch.status : "", sem: Number(sub.semester), rows: [] };
      const data = await App.loadSubjectData(sub.id);
      groups[key].rows.push({ sub, t: data.tally(me.id) });
    }

    let html = "";
    Object.entries(groups)
      .sort((a, b) => b[1].sem - a[1].sem)
      .forEach(([label, g]) => {
        let gp = 0, gt = 0;
        let rowsHtml = "";
        g.rows.sort((a, b) => String(a.sub.name).localeCompare(String(b.sub.name)))
          .forEach(({ sub, t }) => {
            gp += t.present; gt += t.total;
            const pct = t.percent === null ? "—" : t.percent + "%";
            const low = t.percent !== null && t.percent < 75;
            rowsHtml += `<tr style="${low ? "background:#ffe0e0;" : ""}">
              <td style="text-align:left;">${App.esc(sub.name)} <small>[${App.esc(sub.type)}]</small></td>
              <td>${t.present} / ${t.total}${t.leave ? ` <small style="color:#1d4ed8;">(+${t.leave} leave)</small>` : ""}</td>
              <td><b>${pct}</b>${low ? " ⚠️ LOW" : ""}</td></tr>`;
          });

        const overall = gt ? Math.round((gp / gt) * 100) : null;
        const ok = overall === null || overall >= 75;
        const color = overall === null ? "#555" : (ok ? "green" : "red");
        const statusText = overall === null ? "No classes recorded yet"
          : `${overall}% ${ok ? "✅ ELIGIBLE" : "❌ NOT ELIGIBLE"}`;
        const tag = g.status === "ACTIVE" ? " — current" : (g.status ? ` — ${g.status.toLowerCase()}` : "");

        html += `
          <div style="margin-bottom:20px;">
            <h3 style="margin-bottom:6px;">${App.esc(label)}${tag}</h3>
            <div style="padding:8px; border:2px solid ${color}; color:${color}; font-weight:bold; margin-bottom:8px;">
              Semester overall: ${statusText}
            </div>
            <table border="1" cellpadding="5" width="100%">
              <tr><th style="text-align:left;">Subject</th><th>Attended / Held</th><th>%</th></tr>
              ${rowsHtml}
            </table>
          </div>`;
      });

    output.innerHTML = html;
    App.Student.initRegister(mySubjects, batches, me);
  } catch (e) {
    console.error(e);
    output.innerHTML = "<p style='color:red;'>Could not load attendance. Check your internet connection and refresh.</p>";
  }
};

// "My day-by-day register": which days was I present/absent in a subject?
App.Student.initRegister = function (mySubjects, batches, me) {
  const box = document.getElementById("studentRegisterBox");
  const select = document.getElementById("studentRegSubject");
  const monthInput = document.getElementById("studentRegMonth");
  const btn = document.getElementById("studentRegBtn");
  const out = document.getElementById("studentRegOutput");
  if (!box || !select || !monthInput || !btn || !out) return;

  box.style.display = "block";
  select.innerHTML = "";
  mySubjects.forEach(sub => {
    const o = document.createElement("option");
    o.value = sub.id;
    o.textContent = App.subjectLabel(sub, batches);
    select.appendChild(o);
  });
  if (!monthInput.value) monthInput.value = new Date().toLocaleDateString("en-CA").slice(0, 7);
  out.innerHTML = "";

  btn.onclick = async () => {
    const subjectId = select.value;
    const monthVal = monthInput.value;
    if (!subjectId || !monthVal) { UI.alert("Choose a subject and a month."); return; }
    out.innerHTML = "<p>Loading…</p>";
    try {
      const [y, m] = monthVal.split("-").map(Number);
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const from = `${monthVal}-01`, to = `${monthVal}-${String(last).padStart(2, "0")}`;
      const data = await App.loadSubjectData(subjectId);
      const rows = [];
      for (const d of App.datesBetween(from, to)) {
        const closed = data.closedReason(d);
        if (closed && closed.type === "sunday") continue;
        let status = null, note = "";
        if (closed) { status = "Holiday"; note = closed.reason || ""; }
        else if (data.isCancelled(d)) status = "Class not held";
        else {
          status = data.effective(d, me.id);
          if (status && data.isCorrected(d, me.id)) note = "corrected by HOD";
          if (status === "Leave") {
            const lv = data.leaveOf(d, me.id);
            note = (App.LEAVE_TYPES[lv && lv.type] || "") + (note ? ", " + note : "");
          }
        }
        if (status) rows.push({ d, status, note });
      }
      const t = data.tally(me.id, from, to);
      if (!rows.length) { out.innerHTML = "<p>No classes recorded for you in this month.</p>"; return; }
      const colour = { Present: "#d4edda", Absent: "#f8d7da", Leave: "#dbeafe", Holiday: "#d1ecf1", "Class not held": "#fff3cd" };
      let html = `<p><b>${t.present}</b> present, <b>${t.absent}</b> absent` + (t.leave ? `, <b>${t.leave}</b> on leave` : "") +
                 (t.percent === null ? "" : ` — <b>${t.percent}%</b>`) + `</p>
        <table border="1" cellpadding="5" width="100%" style="border-collapse:collapse;">
        <tr><th>Date</th><th>Day</th><th>Status</th></tr>`;
      rows.forEach(r => {
        const [yy, mm, dd] = r.d.split("-").map(Number);
        const day = new Date(Date.UTC(yy, mm - 1, dd)).toLocaleDateString("en-GB", { weekday: "short", timeZone: "UTC" });
        html += `<tr style="background:${colour[r.status] || ""}">
          <td>${String(dd).padStart(2, "0")}/${String(mm).padStart(2, "0")}/${yy}</td><td>${day}</td>
          <td><b>${r.status}</b>${r.note ? ` <small>(${App.esc(r.note)})</small>` : ""}</td></tr>`;
      });
      out.innerHTML = html + "</table>";
    } catch (e) {
      console.error(e);
      out.innerHTML = "<p style='color:red;'>Could not load. Check your internet connection.</p>";
    }
  };
};

// ==========================
// Boot Low Attendance
// ==========================

App.SECTION_RULES = {
  HOD: [
    "hodDashboardSection",
    "attendanceSection",
    "reportsSection",
    "defaultersSection",
    "adminSection",
    "correctionsSection",
    "recordsSection",
    "archiveSection",
    "exitRegistrySection"
  ],
  Teacher: [
    "attendanceSection",
    "reportsSection",
    "myRequestsSection"
  ],
  Student: [
    "studentDashboardSection"     // dashboard includes "My day-by-day register"
  ]
};
App.canAccess = function (sectionId) {
  const u = Auth.currentUser();
  return !!u && (App.SECTION_RULES[u.role] || []).includes(sectionId);
};

function applyRoleGuards() {
  const user = Auth.currentUser();
  if (!user) return;

  const role = user.role;

const rules = App.SECTION_RULES;

  // Sidebar buttons
  document.querySelectorAll("#sidebar button").forEach(btn => {
    const target = btn.getAttribute("onclick");
    if (!target) return;

    const match = target.match(/showSection\('(.+?)'\)/);
    if (!match) return;
    const sectionId = match[1]; 
    const allowed = rules[role] || [];

  if (!allowed.includes(sectionId)) {
  btn.style.display = "none";
  } else {
  btn.style.display = "";
  }
  });
  document.querySelectorAll("#sidebar .menu-group").forEach(group => {
    const anyShown = [...group.querySelectorAll("button")].some(b => b.style.display !== "none" && !b.classList.contains("installAppBtn"));
    group.style.display = anyShown ? "" : "none";
  });
  

  // Role badge
  let badge = document.getElementById("roleBadge");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "roleBadge";
    badge.style.position = "fixed";
    badge.style.top = "10px";
    badge.style.right = "10px";
    badge.style.padding = "6px 10px";
    badge.style.background = "#333";
    badge.style.color = "#fff";
    badge.style.borderRadius = "5px";
    badge.style.fontSize = "12px";
    document.body.appendChild(badge);
  }
  badge.textContent = `Logged in as: ${role}`;
}

// ==========================
// Defaulters Module — SUBJECT WISE + CLEAN TERMINOLOGY
// ==========================

App.Defaulters = {};

  App.Defaulters.init = async function () {
  const subjectSelect = document.getElementById("defaulterBatchSelect");
  const generateBtn = document.getElementById("generateDefaultersBtn");
  const output = document.getElementById("defaultersOutput");
  const printBtn = document.getElementById("printDefaultersNoticeBtn");

  if (!subjectSelect || !generateBtn || !output) return;

  const LOW_THRESHOLD = 75;

  // ---------- Load Subjects (FULL LABEL) ----------
    async function loadSubjects() {
    const subjects = await App.getSubjects();
    const batches = await App.getBatches();
    subjectSelect.innerHTML = "";

    const opt0 = document.createElement("option");
    opt0.value = "";
    opt0.textContent = "Select Subject";
    subjectSelect.appendChild(opt0);
    subjects.forEach(sub => {  // 👈 ADD THIS
    const batch = batches.find(
    b => String(b.id) === String(sub.batchId) &&
    String(b.semester) === String(sub.semester));

      const batchText = batch
        ? `${batch.program} Sem ${batch.semester} (Batch ${batch.year})`
        : "Unknown Batch";

      const opt = document.createElement("option");
      opt.value = sub.id;
      opt.textContent = `${sub.name} | ${sub.type} | ${batchText}`;
      subjectSelect.appendChild(opt);
    });
  }

  // ---------- Generate List ----------
    async function generateList() {
    const subjectId = subjectSelect.value;
    if (!subjectId) {
      UI.alert("Select a subject");
      return;
    }

    output.innerHTML = "<p>Calculating...</p>";
    const students = await App.getStudents();
    const subject = (await App.getSubjects()).find(s => String(s.id) === String(subjectId));
    if (!subject) return;

    const enrollments = await App.getEnrollments();
    const data = await App.loadSubjectData(subjectId);
    const ids = [...new Set([
      ...(enrollments[String(subjectId)] || []).map(String),
      ...data.recordedStudentIds()
    ])];

    const rows = [];
    for (const id of ids) {
      const student = students.find(s => String(s.id) === id);
      if (!student) continue;
      const t = data.tally(id);
      if (t.total === 0) continue;
      if (t.percent < LOW_THRESHOLD) {
        rows.push({ roll: App.esc(student.roll), name: App.esc(student.name), percent: t.percent });
      }
    }

    render(rows, subject);
  }

  // ---------- Render ----------
  function render(rows, subject) {
    if (rows.length === 0) {
      output.innerHTML =
        "<p><b>No students with attendance shortage found.</b></p>";
      return;
    }

    rows.sort((a, b) => a.percent - b.percent);

    let html = `
      <h3>${App.esc(subjectSelect.options[subjectSelect.selectedIndex].text)}</h3>

      <table border="1" cellpadding="5" width="100%" style="border-collapse:collapse;">
        <tr style="background:#eee;">
          <th>Roll</th>
          <th>Name</th>
          <th>%</th>
          <th>Status</th>
        </tr>
    `;

    rows.forEach(r => {
      html += `
        <tr style="background:#fff3cd">
          <td>${r.roll}</td>
          <td>${r.name}</td>
          <td><b>${r.percent}%</b></td>
          <td><b>Attendance Shortage</b></td>
        </tr>
      `;
    });

    html += "</table>";
    output.innerHTML = html;
  }

  // ---------- Print Notice ----------
if (printBtn) {
  printBtn.onclick = async function () {
    const table = document.querySelector("#defaultersOutput table");
    if (!table) {
      UI.alert("Generate the list first");
      return;
    }

    const today = new Date().toLocaleDateString();

    const html = `
      <html>
      <head>
        <title>Office Order - Short Attendance</title>
        <style>
          body { font-family: "Times New Roman", serif; padding: 40px; }
          .center { text-align: center; }
          .title { font-size: 20px; font-weight: bold; margin-top: 10px; }
          .subtitle { font-size: 16px; margin-top: 5px; }
          .section { margin-top: 20px; font-size: 16px; line-height: 1.6; }
          table { width: 100%; border-collapse: collapse; margin-top: 20px; }
          table, th, td { border: 1px solid black; }
          th, td { padding: 6px; text-align: left; }
          .footer { margin-top: 50px; display: flex; justify-content: space-between; }
        </style>
      </head>
      <body>

        <div class="center">
          <div class="title">AMAR SINGH COLLEGE, SRINAGAR</div>
          <div class="subtitle">DEPARTMENT OF ECONOMICS</div>
          <div class="title" style="margin-top:20px;">OFFICE ORDER</div>
        </div>

        <div class="section">
          <b>Date:</b> ${today}
        </div>

        <div class="section">
          In accordance with <b>University norms</b>, the following students have been found to have attendance <b>below 75%</b>.
        </div>

        <div class="section">
          Accordingly, these students <b>shall not be allowed to appear in the Internal Examinations</b>.
        </div>

        <div class="section">
          This order is issued for information and strict compliance.
        </div>

        <div class="section">
          <b>List of Students:</b>
        </div>

        ${table.outerHTML}

        <div class="footer">
          <div><b>Date:</b> ${today}</div>
          <div style="text-align:right;">
            __________________________<br>
            <b>Head of Department</b><br>
            Department of Economics<br>
            Amar Singh College, Srinagar
          </div>
        </div>

      </body>
      </html>
    `;

    const w = window.open("", "_blank");
    w.document.write(html);
    w.document.close();
    w.focus();
    w.print();
    w.close();
  };
}

  await loadSubjects();
  generateBtn.onclick = generateList;
};

// ==========================
// Unified Auth UI Controller
// ==========================

function clearSensitiveOutputs() {
  const ids = [
    "reportOutput",
    "registerOutput",
    "lowOutput",
    "defaultersOutput",
     "archiveResults" 
  ];

  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = "";
  });
}
function updateAuthUI() {
  const loginScreen = document.getElementById("loginScreen");
  const appContainer = document.getElementById("appContainer");

  if (!loginScreen || !appContainer) return;

  const user = Auth.currentUser(); // 🔍 Get the user's role

  // ✅ SURGICAL STABILIZER (ADD THIS BLOCK)
  if (Auth.isLoggedIn() && !user) {
    Auth.logout();
    location.reload();
    return;
  }

  if (Auth.isLoggedIn() && user) {
    loginScreen.style.display = "none";
    appContainer.style.display = "flex";
    
  } else {
    loginScreen.style.display = "block";
    appContainer.style.display = "none";
  }
}

// ---------- Entering / leaving the app ----------
App.showLoginScreen = function (message) {
  const appContainer = document.getElementById("appContainer");
  const loginScreen = document.getElementById("loginScreen");
  if (appContainer) appContainer.style.display = "none";
  if (loginScreen) loginScreen.style.display = "block";
  const err = document.getElementById("loginError");
  if (err) err.textContent = message || "";
  App.refreshSetupLink();
};

App.enterApp = function (restoreLastSection) {
  clearSensitiveOutputs();
  updateAuthUI();
  applyRoleGuards();
  resetIdleTimer();
  const user = Auth.currentUser();
  if (!user) { App.showLoginScreen(); return; }
  const home = user.role === "Student" ? "studentDashboardSection"
             : user.role === "HOD" ? "hodDashboardSection"
             : "attendanceSection";
  const last = restoreLastSection ? localStorage.getItem("lastSection") : null;
  showSection(last && App.canAccess(last) ? last : home);
};

// Called once at startup, when Firebase has restored (or not) the previous login
App.resumeSession = async function (fbUser) {
  const cached = Auth.currentUser();
  if (!fbUser || !cached || cached.uid !== fbUser.uid) {
    if (fbUser) await auth.signOut().catch(() => {});
    localStorage.removeItem("currentUser");
    App.showLoginScreen();
    return;
  }
  let profile;
  try {
    profile = await Auth.loadProfile(fbUser.uid);
  } catch (e) {
    console.warn("Could not refresh profile; using saved session", e);
    profile = undefined;           // offline: carry on with the cached session
  }
  if (profile === null || (profile && (profile.active !== true || profile.mustChangePassword))) {
    const msg = profile && profile.active !== true ? "This account has been deactivated. Contact the HOD." : "";
    await Auth.logout();
    App.showLoginScreen(msg);
    return;
  }
  if (profile) localStorage.setItem("currentUser", JSON.stringify(Auth.profileToSessionUser(fbUser.uid, profile)));
  App.enterApp(true);
};

// ---------- First-time HOD setup ----------
App.refreshSetupLink = async function () {
  const link = document.getElementById("setupLink");
  if (!link) return;
  link.style.display = (await Auth.isSetupDone()) ? "none" : "inline";
};

App.initSetupPanel = function () {
  const link = document.getElementById("setupLink");
  const panel = document.getElementById("setupPanel");
  const btn = document.getElementById("setupBtn");
  const msg = document.getElementById("setupMessage");
  if (!link || !panel || !btn) return;

  link.onclick = e => {
    e.preventDefault();
    panel.style.display = panel.style.display === "none" ? "block" : "none";
  };
  btn.onclick = async () => {
    const name = document.getElementById("setupName").value.trim();
    const loginId = Auth.normalizeLoginId(document.getElementById("setupLoginId").value);
    const pw = document.getElementById("setupPassword").value;
    const pw2 = document.getElementById("setupPassword2").value;
    msg.style.color = "red";
    if (!name) { msg.textContent = "Enter the HOD's name."; return; }
    if (!Auth.isValidLoginId(loginId)) { msg.textContent = "Login ID: letters, numbers, dots or dashes (e.g. hod)."; return; }
    if (pw.length < 8) { msg.textContent = "Password must be at least 8 characters."; return; }
    if (pw !== pw2) { msg.textContent = "The two passwords don't match."; return; }

    btn.disabled = true;
    msg.style.color = "#555";
    msg.textContent = "Creating HOD account…";
    try {
      await Auth.setupHod(loginId, name, pw);
      panel.style.display = "none";
      link.style.display = "none";
      ["setupPassword", "setupPassword2"].forEach(id => document.getElementById(id).value = "");
      msg.textContent = "";
      App.enterApp(false);
      UI.alert(`HOD account created.\n\nFrom now on, log in with:\nLogin ID: ${loginId}\nand the password you just chose.`);
    } catch (e) {
      console.error(e);
      msg.style.color = "red";
      msg.textContent = "Setup failed: " + App.Accounts.errorText(e);
    } finally {
      btn.disabled = false;
    }
  };
};

// ---------- Change password (forced at first login, or any time from the menu) ----------
App.showPasswordPanel = function ({ forced }) {
  const panel = document.getElementById("passwordPanel");
  if (!panel) return;
  App._pwForced = forced;
  document.getElementById("passwordPanelTitle").textContent = forced ? "Choose your own password" : "Change password";
  document.getElementById("passwordPanelNote").textContent = forced
    ? "For your security, replace the starting password you were given with one only you know."
    : "";
  document.getElementById("currentPasswordRow").style.display = forced ? "none" : "block";
  document.getElementById("pwCancelBtn").textContent = forced ? "Log out" : "Cancel";
  ["pwCurrent", "pwNew", "pwConfirm"].forEach(id => document.getElementById(id).value = "");
  document.getElementById("pwMessage").textContent = "";
  panel.style.display = "flex";
};

App.initPasswordPanel = function () {
  const panel = document.getElementById("passwordPanel");
  if (!panel) return;
  const msg = document.getElementById("pwMessage");
  const saveBtn = document.getElementById("pwSaveBtn");

  document.getElementById("pwCancelBtn").onclick = async () => {
    panel.style.display = "none";
    if (App._pwForced) { await Auth.logout(); location.reload(); }
  };

  saveBtn.onclick = async () => {
    const current = App._pwForced ? Auth._lastPassword : document.getElementById("pwCurrent").value;
    const pw = document.getElementById("pwNew").value;
    const pw2 = document.getElementById("pwConfirm").value;
    msg.style.color = "red";
    if (!current) { msg.textContent = App._pwForced ? "Please log in again." : "Enter your current password."; return; }
    if (pw.length < 6) { msg.textContent = "New password must be at least 6 characters."; return; }
    if (pw !== pw2) { msg.textContent = "The two new passwords don't match."; return; }
    if (pw === current) { msg.textContent = "Choose a password different from the current one."; return; }

    saveBtn.disabled = true;
    msg.style.color = "#555";
    msg.textContent = "Saving…";
    try {
      await Auth.changePassword(current, pw);
      panel.style.display = "none";
      if (App._pwForced) App.enterApp(false);
      else UI.alert("Password changed.");
    } catch (e) {
      console.error(e);
      msg.style.color = "red";
      msg.textContent = (e.code === "auth/wrong-password" || e.code === "auth/invalid-credential")
        ? "Current password is incorrect."
        : App.Accounts.errorText(e);
    } finally {
      saveBtn.disabled = false;
    }
  };
};

document.addEventListener("DOMContentLoaded", function () {
  ["click", "mousemove", "keydown", "scroll"].forEach(event => {
    document.addEventListener(event, resetIdleTimer);
  });

  const loginBtn = document.getElementById("loginBtn");
  const logoutBtn = document.getElementById("logoutBtn");
  const errorBox = document.getElementById("loginError");

  // Show nothing until Firebase tells us whether someone is already signed in
  const loginScreen = document.getElementById("loginScreen");
  const appContainer = document.getElementById("appContainer");
  if (loginScreen) loginScreen.style.display = "none";
  if (appContainer) appContainer.style.display = "none";

  App.initPasswordPanel();
  App.initSetupPanel();

  if (loginBtn) {
    loginBtn.onclick = async function () {
      const u = document.getElementById("loginUsername").value;
      const pField = document.getElementById("loginPassword");
      if (errorBox) errorBox.textContent = "";
      loginBtn.disabled = true;
      loginBtn.textContent = "Logging in…";
      const res = await Auth.login(u, pField.value);
      loginBtn.disabled = false;
      loginBtn.textContent = "Login";
      if (!res.ok) {
        if (errorBox) errorBox.textContent = res.error;
        return;
      }
      pField.value = "";
      if (res.mustChangePassword) {
        App.showPasswordPanel({ forced: true });
        return;
      }
      App.enterApp(false);
    };
    ["loginUsername", "loginPassword"].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("keydown", e => { if (e.key === "Enter") loginBtn.click(); });
    });
  }

  if (logoutBtn) {
    logoutBtn.onclick = async function () {
      clearSensitiveOutputs();
      await Auth.logout();
      location.reload();
    };
  }

  const changePwBtn = document.getElementById("changePasswordBtn");
  if (changePwBtn) changePwBtn.onclick = () => App.showPasswordPanel({ forced: false });
  const recoveryBtn = document.getElementById("recoveryBtn");
  if (recoveryBtn) recoveryBtn.onclick = () => App.Recovery.showPanel();
  App.Recovery.init();

  let decided = false;
  auth.onAuthStateChanged(fbUser => {
    if (decided) return;          // only the first answer (session restore) matters here
    decided = true;
    App.resumeSession(fbUser);
  });
});

function showSection(id) {
  const user = Auth.currentUser();
  if (!user) return;

  const rules = App.SECTION_RULES;

   const allowed = rules[user.role] || [];

   if (!allowed.includes(id)) {
  UI.alert("Access denied.");
  return;
  }

  // Hide all sections
  document.querySelectorAll(".section").forEach(sec => {
    sec.classList.remove("active");
  });
  // ✅ CLEAR ARCHIVE RESULTS WHEN LEAVING ARCHIVE ROOM
if (id !== "archiveSection") {
  archiveSearchTriggered = false;

  const archiveResults = document.getElementById("archiveResults");
  if (archiveResults) archiveResults.innerHTML = "";
}


  // Always recalculate from fresh data when a screen opens
  App.clearAttendanceCaches();

  // 🧹 Always clear old report content when opening Reports
  if (id === "reportsSection") {
    clearSensitiveOutputs();
  }

  // Initialise Cancelled Classes Log ONLY when that page opens


// Show target

  const target = document.getElementById(id);
  if (target) { target.classList.add("active");
  localStorage.setItem("lastSection", id);   // ✅ ADD THIS LINE
  }

// ==========================================
  // COMPLETE MODULE INITIALIZATION
  // ==========================================
  if (id === "studentDashboardSection") App.Student.init();
  if (id === "attendanceSection") App.Attendance.init();
  if (id === "reportsSection") App.Reports.init();
  if (id === "defaultersSection") App.Defaulters.init();
  if (id === "adminSection") {
    initApp();
    renderClosedDays();
    App.Accounts.loadStudentLoginBatches();
    App.Settings.load();
    App.StudentViews.initRebuildButton();
  }
  if (id === "hodDashboardSection") App.HodDash.init();

  if (id === "correctionsSection") { App.CorrectionsPanel.init(); App.HODCorrections.init(); }
  if (id === "myRequestsSection") App.MyRequests.init();
  
  // ⚡ KEY FIXES: Match the names used in your specific app.js
  if (id === "recordsSection") { App.LeaveRegister.render(); App.CancelledClasses.init(); }
  if (id === "archiveSection") {
    // 🔒 LOCK THE GATE: Reset the search flag
    archiveSearchTriggered = false; 
    // 🔑 THE ENGINE: Populate the years dynamically
    loadArchiveYearFilters();

    const results = document.getElementById("archiveResults");
    if (results) {
      results.innerHTML = "<p style='color:#888; font-style:italic; padding:20px;'>Select filters and click 'Search Archive' to view history.</p>";
    }
    if (archiveYearFilter) archiveYearFilter.value = "all";
    if (archiveProgramFilter) archiveProgramFilter.value = "all";
  }
} // 🟢 THIS CLOSES THE showSection FUNCTION COMPLETELY


// ==========================
// ATTENDANCE CORRECTION ENGINE (IMMUTABLE)
// ==========================

App.getCorrectionRequests = async function () {
  try {
    const snapshot = await db.collection("correctionRequests").get();
    const list = [];
    snapshot.forEach(doc => list.push(doc.data()));
    return list;
  } catch (e) {
    console.warn("Firestore read failed", e);
    return [];
  }
};

App.getAttendanceCorrections = async function () {
  try {
    const snapshot = await db.collection("attendanceCorrections").get();
    const list = [];
    snapshot.forEach(doc => list.push(doc.data()));
    return list;
  } catch (e) {
    console.warn("Firestore read failed", e);
    return [];
  }
};

// Get effective attendance (original + corrections)

// Create correction request (Teacher)
App.requestAttendanceCorrection = async function ({
  subjectId,
  date,
  studentId,
  requestedStatus,
  reason
}) {
  const user = Auth.currentUser();
  if (!user || user.role !== "Teacher") return false;

  if (!App._attendanceCache) App._attendanceCache = {};

const key = String(subjectId) + "_" + date;

if (!App._attendanceCache[key]) {
  App._attendanceCache[key] = await App.getAttendance(subjectId, date);
}

const original = App._attendanceCache[key];
  if (!original || !original[studentId]) return false;
  requestedStatus = App.normalizeStatus(requestedStatus);
  if (!requestedStatus) return false;
  const request = {
  id: Date.now() + Math.random(),
  subjectId,
  date,
  studentId,
  oldStatus: original[studentId],
  requestedStatus,
  reason,
  requestedBy: user.id,
  requestedAt: new Date().toISOString(),
  status: "pending"
};
  // 🔥 NEW: save to Firestore
  try {
    await db.collection("correctionRequests").doc(String(request.id)).set(request);
  } catch (e) {
    console.warn("Firestore save failed", e);
    return false;
  }

  return true;
};

// Approve correction (HOD)
App.approveCorrection = async function (requestId) {
  const user = Auth.currentUser();
  if (!user || user.role !== "HOD") return false;

 const doc = await db.collection("correctionRequests")
  .doc(String(requestId))
  .get();

if (!doc.exists) return false;

const req = doc.data();
  if (!req || req.status !== "pending") return false;


  const correctionId = Date.now() + Math.random();

  const correction = {
  id: correctionId,
  subjectId: req.subjectId,
  date: req.date,
  studentId: req.studentId,
  originalStatus: req.oldStatus,
  correctedStatus: req.requestedStatus,
  decision: "Approved",
  reason: req.reason,
  requestedBy: req.requestedBy,
  approvedBy: user.username || "HOD",
  timestamp: new Date().toISOString()
};
  try {
  await db.collection("attendanceCorrections")
  .doc(String(correctionId))
  .set(correction);
   } catch (e) {
  console.warn("Firestore correction save failed", e);
  }
  // The student sees the correction through their own copy
  await App.StudentViews.setCorrection(req.studentId, req.subjectId, req.date, req.requestedStatus)
    .catch(e => console.warn("Student copy of correction not saved", e));

  req.status = "approved";
  req.reviewedBy = user.username || "HOD";
  req.reviewedAt = new Date().toISOString();
  try {
  await db.collection("correctionRequests")
    .doc(String(req.id))
    .update({
      status: "approved",
      reviewedBy: req.reviewedBy,
      reviewedAt: req.reviewedAt
    });
} catch (e) {
  console.warn("Firestore request update failed", e);
}

  return true;
};

// Reject correction (HOD)
App.rejectCorrection = async function (requestId) {
  const user = Auth.currentUser();
  if (!user || user.role !== "HOD") return false;

  const doc = await db.collection("correctionRequests")
  .doc(String(requestId))
  .get();

if (!doc.exists) return false;

const req = doc.data();
  if (!req || req.status !== "pending") return false;

  // 🔴 ADD REJECTED ENTRY TO CORRECTION REGISTER
  const correctionId = Date.now() + Math.random();

  const correction = {
  id: correctionId,
  subjectId: req.subjectId,
  date: req.date,
  studentId: req.studentId,
  originalStatus: req.oldStatus,
  correctedStatus: null,
  decision: "Rejected",
  reason: req.reason,
  requestedBy: req.requestedBy,
  approvedBy: user.username || "HOD",
  timestamp: new Date().toISOString()
};
  try {
  await db.collection("attendanceCorrections")
    .doc(String(correctionId))
    .set(correction);
  } catch (e) {
  console.warn("Firestore correction save failed", e);
  }
  

  // Mark request as rejected
  req.status = "rejected";
  req.reviewedBy = user.username || "HOD";
  req.reviewedAt = new Date().toISOString();
  try {
  await db.collection("correctionRequests")
    .doc(String(req.id))
    .update({
      status: "rejected",
      reviewedBy: req.reviewedBy,
      reviewedAt: req.reviewedAt
    });
} catch (e) {
  console.warn("Firestore request update failed", e);
}
  return true;
};

// ==========================
// HOD Correction Requests Panel (FIXED, REAL DATA)
// ==========================

App.CorrectionsPanel = {};

App.CorrectionsPanel.init = async function () {
  const container = document.getElementById("correctionRequestsOutput");
  if (!container) return;

   
  if (App._corrUnsub) App._corrUnsub();
  App._corrUnsub = db.collection("correctionRequests")
  .onSnapshot(async snapshot => {

    const requests = [];
    snapshot.forEach(doc => requests.push(doc.data()));

    const user = Auth.currentUser();
    if (!user || user.role !== "HOD") {
      container.innerHTML = "<p>Access denied.</p>";
      return;
    }

    const students = await App.getStudents();
    const subjects = await App.getSubjects();

    const pending = requests.filter(r => r.status === "pending");

    if (pending.length === 0) {
      container.innerHTML = "<p>No pending correction requests.</p>";
      return;
    }

    let html = `
      <table border="1" cellpadding="6" width="100%">
        <tr>
          <th>Student</th>
          <th>Subject</th>
          <th>Date</th>
          <th>Old</th>
          <th>New</th>
          <th>Reason</th>
          <th>Action</th>
        </tr>
    `;

    pending.forEach(req => {
      const student = students.find(s => String(s.id) === String(req.studentId));
      const subject = subjects.find(s => String(s.id) === String(req.subjectId));

      const studentText = student
        ? `${student.roll} - ${student.name}`
        : "Unknown student";

      const subjectText = subject
        ? subject.name
        : "Unknown subject";

      html += `
        <tr>
          <td>${App.esc(studentText)}</td>
          <td>${App.esc(subjectText)}</td>
          <td>${App.esc(req.date)}</td>
          <td>${App.esc(req.oldStatus)}</td>
          <td><b>${App.esc(req.requestedStatus)}</b></td>
          <td>${App.esc(req.reason)}</td>
          <td>
            <button data-corr-action="approve" data-corr-id="${App.esc(String(req.id))}">Approve</button>
            <button data-corr-action="reject" data-corr-id="${App.esc(String(req.id))}">Reject</button>
          </td>
        </tr>
      `;
    });

    html += "</table>";
    container.innerHTML = html;
    container.querySelectorAll("button[data-corr-action]").forEach(b => {
      b.onclick = () => {
        const id = b.getAttribute("data-corr-id");
        if (b.getAttribute("data-corr-action") === "approve") App.CorrectionsPanel.approve(id);
        else App.CorrectionsPanel.reject(id);
      };
    });
});
};

App.CorrectionsPanel.approve = async function (id) {
  const ok = await UI.confirm("Approve this correction?", { okText: "Approve" });
  if (!ok) return;

  const success = await App.approveCorrection(id);
  if (!success) {
    UI.alert("Approval failed.");
    return;
  }

  UI.alert("Correction approved.");

  // refresh pending requests

  // ✅ refresh Attendance Correction Register immediately
    if (App.HODCorrections && App.HODCorrections.render) {
  App.HODCorrections.render();
}
};
App.CorrectionsPanel.reject = async function (id) {
  const ok = await UI.confirm("Reject this correction?", { okText: "Reject", danger: true });
  if (!ok) return;

  const success = await App.rejectCorrection(id);
  if (!success) {
    UI.alert("Rejection failed.");
    return;
  }

  UI.alert("Correction rejected.");

  // refresh pending requests

  // ✅ refresh Attendance Correction Register immediately
    if (App.HODCorrections && App.HODCorrections.render) {
  App.HODCorrections.render();
}
};

// ==========================
// Teacher: My Correction Requests Panel (FIXED, STRICT ID MATCH)
// ==========================

App.MyRequests = {};

App.MyRequests.init = async function () {
  const container = document.getElementById("myRequestsOutput");
  if (!container) return;

  const user = Auth.currentUser();
  if (!user || user.role !== "Teacher") {
    container.innerHTML = "<p>Access denied.</p>";
    return;
  }
if (App._corrUnsub) App._corrUnsub();
App._corrUnsub = db.collection("correctionRequests")
.onSnapshot(async snapshot => {

  const requests = [];
  snapshot.forEach(doc => requests.push(doc.data()));

  const students = await App.getStudents();
  const subjects = await App.getSubjects();

  const myRequests = requests.filter(r =>
    String(r.requestedBy) === String(user.id)
  );

  if (myRequests.length === 0) {
    container.innerHTML = "<p>You have not submitted any requests.</p>";
    return;
  }

  let html = `
    <table border="1" cellpadding="6" width="100%">
      <tr>
        <th>Student</th>
        <th>Subject</th>
        <th>Date</th>
        <th>Old</th>
        <th>Requested</th>
        <th>Reason</th>
        <th>Status</th>
        <th>Reviewed By</th>
        <th>Reviewed At</th>
      </tr>
  `;

  myRequests.forEach(req => {
    const student = students.find(s => String(s.id) === String(req.studentId));
    const subject = subjects.find(s => String(s.id) === String(req.subjectId));

    const studentText = student ? `${student.roll} - ${student.name}` : "Unknown";
    const subjectText = subject ? subject.name : "Unknown";

    const statusColor =
      req.status === "approved" ? "green" :
      req.status === "rejected" ? "red" :
      "orange";

    html += `
      <tr>
        <td>${App.esc(studentText)}</td>
        <td>${App.esc(subjectText)}</td>
        <td>${App.esc(req.date)}</td>
        <td>${App.esc(req.oldStatus)}</td>
        <td><b>${App.esc(req.requestedStatus)}</b></td>
        <td>${App.esc(req.reason)}</td>
        <td style="color:${statusColor}; font-weight:bold;">${App.esc(String(req.status || "").toUpperCase())}</td>
        <td>${App.esc(req.reviewedBy || "-")}</td>
        <td>${req.reviewedAt ? new Date(req.reviewedAt).toLocaleString() : "-"}</td>
      </tr>
    `;
  });

  html += "</table>";
  container.innerHTML = html;
});
};
// ==========================
// SUBJECT NAME FORMAT (DO NOT TOUCH)
// ==========================
// ==========================
// HOD Attendance Correction Register (READ-ONLY)
// ==========================

App.HODCorrections = {};

App.HODCorrections.init = async function () {
  const user = Auth.currentUser();
  if (!user || user.role !== "HOD") return;

  const output = document.getElementById("hodCorrectionsOutput");
  if (!output) return;

    async function render() {
    const corrections = await App.getAttendanceCorrections(); // ✅ MOVED HERE
    const students = await App.getStudents();
    const subjects = await App.getSubjects();
    const batches = await App.getBatches();
    const teachers = await App.getTeachersFromFirestore();

    if (corrections.length === 0) {
      output.innerHTML = "<p>No attendance corrections recorded.</p>";
      return;
    }

    let html = `
      <table border="1" cellpadding="5" width="100%" style="border-collapse:collapse;">
        <tr style="background:#eee;">
          <th>Student</th>
          <th>Subject</th>
          <th>Date</th>
          <th>Original</th>
          <th>Corrected</th>
          <th>Reason</th>
          <th>Requested By</th>
          <th>Decision</th>
          <th>Approved By</th>
          <th>Approved At</th>
        </tr>
    `;

      corrections.forEach(c => {
      const student = students.find(s => String(s.id) === String(c.studentId));
      const subject = subjects.find(s => String(s.id) === String(c.subjectId));
      if (!student || !subject) return;
      const batch = batches.find(b => String(b.id) === String(subject.batchId) && String(b.semester) === String(subject.semester));
      const batchText = batch
        ? `${batch.program} Batch ${batch.year} Sem ${batch.semester}`
        : "Unknown Batch";

      const teacher = teachers.find(t => String(t.id) === String(c.requestedBy));
      const teacherName = teacher ? teacher.name : "Teacher";

      html += `
        <tr>
          <td>${App.esc(student.roll)} - ${App.esc(student.name)}</td>
          <td>${App.esc(subject.name)} (${App.esc(subject.type)} | ${App.esc(batchText)})</td>
          <td>${App.esc(c.date)}</td>
          <td>${App.esc(c.originalStatus)}</td>
          <td>${App.esc(c.correctedStatus)}</td>
          <td>${App.esc(c.reason || "")}</td>
          <td>${App.esc(teacherName)}</td>
          <td>${App.esc(c.decision || "Approved")}</td>
          <td>${App.esc(c.approvedBy || "")}</td>
          <td>${c.timestamp ? new Date(c.timestamp).toLocaleString() : ""}</td>
        </tr>
      `;
    });

    html += "</table>";
    output.innerHTML = html;
  }

  App.HODCorrections.render = render; // ✅ NEW, harmless
  await render();                           // initial draw
};

function exportToExcel() {
  // Find the report table currently visible
  const table =
    document.querySelector("#reportOutput table") ||
    document.querySelector("#registerOutput table");

  // If no table exists, stop
  if (!table) {
    UI.alert("Please generate a report first.");
    return;
  }

  // Create a new Excel workbook
  const workbook = XLSX.utils.book_new();

  // Convert the HTML table to an Excel sheet
  const sheet = XLSX.utils.table_to_sheet(table);

  // Attach the sheet to the workbook
  XLSX.utils.book_append_sheet(workbook, sheet, "Attendance Report");

  // Download the Excel file
  XLSX.writeFile(workbook, "attendance_report.xlsx");
  }
  function exportToPDF() {
  // Prefer register view if it exists, else summary view
  const content =
    document.getElementById("registerOutput").innerHTML.trim()
      ? document.getElementById("registerOutput")
      : document.getElementById("reportOutput");

  // If nothing to export, stop
  if (!content || !content.innerHTML.trim()) {
    UI.alert("Please generate a report first.");
    return;
  }

  // Convert visible content to PDF
  html2pdf()
    .set({
      filename: "attendance_report.pdf",
      margin: 10,
      jsPDF: { format: "a4", orientation: "landscape" }
    })
    .from(content)
    .save();
  }
  document.getElementById("exportDefaultersExcelBtn")
  ?.addEventListener("click", function () {

    const table = document.querySelector("#defaultersOutput table");

    if (!table) {
      UI.alert("Please generate defaulters list first.");
      return;
    }
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.table_to_sheet(table);

    XLSX.utils.book_append_sheet(workbook, sheet, "Defaulters");
    XLSX.writeFile(workbook, "defaulters_list.xlsx");
}); // 🟢 This closes the Defaulters button listener correctly.

// ==========================================
// HOD EXECUTIVE DASHBOARD (ENHANCED)
// ==========================================
  App.updateHODStats = async function() {
  const students = await App.getStudents();
  const today = new Date().toLocaleDateString("en-CA");   // local date, YYYY-MM-DD
  const subjects = await App.getSubjects();

  // 📈 STOCK: Total counts in the department
  const activeCount = students.filter(s => !s.status || s.status === "ACTIVE").length;
  const gradCount = students.filter(s => s.status === "GRADUATED").length;
  const dropCount = students.filter(s => s.status === "DROPPED").length;

  // 🗓️ FLOW: Today's live activity
  let totalPresentToday = 0;
  let totalAbsentToday = 0;
  let classesConductedToday = 0;

  for (const sub of subjects) {
  const attendance = await App.getAttendance(sub.id, today);

  if (attendance && Object.keys(attendance).length > 0) {
    classesConductedToday++;

    Object.values(attendance).forEach(status => {
      const s = App.normalizeStatus(status);
      if (s === "Present") totalPresentToday++;
      if (s === "Absent") totalAbsentToday++;
    });
    totalAbsentToday -= (await App._getDocsByIdPrefix("leaves", `${sub.id}_${today}_`)).length;   // leave is not absence
  }
}

  const widget = document.getElementById("hodStatsWidget");
  if (widget) {
    widget.innerHTML = `
      <div style="display:flex; gap:10px; width:100%; margin-bottom:10px;">
        <div style="background:#27ae60; color:white; padding:15px; border-radius:8px; flex:1; text-align:center;">
          <h2 style="margin:0;">${activeCount}</h2>
          <p style="margin:5px 0 0; font-size: 0.8em; font-weight:bold;">Active Students</p>
        </div>
        <div style="background:#2980b9; color:white; padding:15px; border-radius:8px; flex:1; text-align:center;">
          <h2 style="margin:0;">${gradCount}</h2>
          <p style="margin:5px 0 0; font-size: 0.8em; font-weight:bold;">Total Graduates</p>
        </div>
        <div style="background:#e67e22; color:white; padding:15px; border-radius:8px; flex:1; text-align:center;">
          <h2 style="margin:0;">${dropCount}</h2>
          <p style="margin:5px 0 0; font-size: 0.8em; font-weight:bold;">Midway Exits</p>
        </div>
      </div>

      <div style="display:flex; gap:10px; width:100%;">
        <div style="background:#8e44ad; color:white; padding:15px; border-radius:8px; flex:1; text-align:center;">
          <h2 style="margin:0;">${classesConductedToday}</h2>
          <p style="margin:5px 0 0; font-size: 0.8em; font-weight:bold;">Classes Today</p>
        </div>
        <div style="background:#16a085; color:white; padding:15px; border-radius:8px; flex:1; text-align:center;">
          <h2 style="margin:0;">${totalPresentToday}</h2>
          <p style="margin:5px 0 0; font-size: 0.8em; font-weight:bold;">Total Present</p>
        </div>
        <div style="background:#c0392b; color:white; padding:15px; border-radius:8px; flex:1; text-align:center;">
          <h2 style="margin:0;">${totalAbsentToday}</h2>
          <p style="margin:5px 0 0; font-size: 0.8em; font-weight:bold;">Total Absent</p>
        </div>
      </div>
    `;
  }
};
// ==========================================
// OFFICIAL ALUMNI PDF GENERATOR
// ==========================================
App.downloadAlumniPDF = function() {
  const table = document.querySelector("#exitRegistryOutput table");
  if (!table) {
    UI.alert("No records found to export.");
    return;
  }

  const today = new Date().toLocaleDateString();
  const html = `
    <div style="font-family: 'Times New Roman', serif; padding: 40px;">
      <div style="text-align: center;">
        <h2 style="margin:0;">AMAR SINGH COLLEGE, SRINAGAR</h2>
        <h3 style="margin:5px 0;">DEPARTMENT OF ECONOMICS</h3>
        <h4 style="text-decoration: underline; margin-top:20px;">OFFICIAL ALUMNI & EXIT REGISTRY</h4>
      </div>
      
      <p style="margin-top:30px;"><b>Date of Report:</b> ${today}</p>
      <p>The following students have officially completed their tenure or exited from the Department of Economics as per the records maintained in the Digital Attendance System.</p>
      
      <div style="margin-top:20px;">
        ${table.outerHTML}
      </div>

      <div style="margin-top:50px; display: flex; justify-content: space-between;">
        <div style="text-align:left;">
          <p><b>System Verified:</b> ${today}</p>
        </div>
        <div style="text-align:right;">
          <p>__________________________</p>
          <p><b>Head of Department</b><br>Department of Economics</p>
        </div>
      </div>
    </div>
  `;

  const opt = {
    margin: 0.5,
    filename: `Economics_Alumni_Report_${today}.pdf`,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2 },
    jsPDF: { unit: 'in', format: 'letter', orientation: 'portrait' }
  };

  html2pdf().from(html).set(opt).save();
};