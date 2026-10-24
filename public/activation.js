// =====================================================================
// Students set up their own login — no printed slips.
//
// First time: roll number + date of birth → they choose a password and a 4-digit
// PIN. Forgot password: roll number + date of birth + PIN → a new password.
// The HOD uploads dates of birth with the student list. Dates of birth and PINs
// are stored only as SHA-256 hashes (studentSecrets), which nobody can read; the
// database rules compare them with what the student types.
//   activation/{loginId}      public: { studentDocId, studentId, departmentId, activated, hasPin }
//   studentSecrets/{loginId}  unreadable: { dobHash, pinHash }
//   activationClaims/{uid}    the student's typed proof for one save, deleted afterwards
// =====================================================================
App.Activation = {};

// A student's login ID from their roll number (same as App.Accounts.studentLoginId for usable roll numbers)
App.Activation.idOf = roll =>
  String(roll || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// "14-03-2005", "14/03/2005", "14.03.2005", "2005-03-14", an Excel date number or a Date → "2005-03-14"
App.Activation.parseDob = function (v) {
  let y, m, d;
  if (v instanceof Date && !isNaN(v)) { y = v.getFullYear(); m = v.getMonth() + 1; d = v.getDate(); }
  else if (typeof v === "number" && v > 1000 && v < 80000) {          // Excel's day count (from 1899-12-30)
    const t = new Date(Math.round((v - 25569) * 86400000));
    y = t.getUTCFullYear(); m = t.getUTCMonth() + 1; d = t.getUTCDate();
  } else {
    const s = String(v == null ? "" : v).trim();
    let r = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
    if (r) { d = +r[1]; m = +r[2]; y = +r[3]; }
    else if ((r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { y = +r[1]; m = +r[2]; d = +r[3]; }
    else return null;
  }
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;   // e.g. 31-02
  if (y < 1940 || t > new Date()) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};
App.Activation.showDob = iso => iso ? iso.split("-").reverse().join("-") : "";

// SHA-256 as upper-case hex (what the database rules compute)
App.Activation.hash = async function (text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("").toUpperCase();
};

// ---------- HOD: dates of birth from the student list ----------
// Returns the writes for each student with a usable date of birth.
App.Activation.writesFor = async function (students, dobByRoll) {
  const writes = [];
  for (const st of students) {
    const dob = dobByRoll[String(st.roll)];
    const id = App.Activation.idOf(st.roll);
    if (!dob || !Auth.isValidLoginId(id)) continue;
    const base = { departmentId: st.departmentId || App.dept(), studentDocId: String(st.id) };
    writes.push({ collection: "activation", id, data: { ...base, studentId: st.id, activated: !!st.uid }, merge: true });
    writes.push({ collection: "studentSecrets", id, data: { ...base, dobHash: await App.Activation.hash(`${id}|${dob}`) }, merge: true });
  }
  return writes;
};
App.Activation.save = async function (writes) {
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    writes.slice(i, i + 400).forEach(w => batch.set(db.collection(w.collection).doc(String(w.id)), w.data, { merge: true }));
    await batch.commit();
  }
};
// After the HOD makes a login (slip) or resets one. Only students whose date of
// birth is on record have an activation record; nothing to do for the others.
App.Activation.loginMadeByHod = async function (st, { clearPin = false } = {}) {
  const id = App.Activation.idOf(st.roll);
  if (!Auth.isValidLoginId(id)) return;
  try {
    if (!(await db.collection("activation").doc(id).get()).exists) return;
    const batch = db.batch();
    batch.update(db.collection("activation").doc(id), { activated: true, ...(clearPin ? { hasPin: false } : {}) });
    if (clearPin) batch.update(db.collection("studentSecrets").doc(id), { pinHash: null });
    await batch.commit();
  } catch (e) {
    console.warn("activation record not updated", e);
  }
};
// Activation records of some students: { loginId: record }
App.Activation.records = async function (students) {
  const ids = [...new Set(students.map(s => App.Activation.idOf(s.roll)).filter(id => Auth.isValidLoginId(id)))];
  const snaps = await Promise.all(ids.map(id => db.collection("activation").doc(id).get()));
  const out = {};
  snaps.forEach((s, i) => { if (s.exists) out[ids[i]] = s.data(); });
  return out;
};

// ---------- student: first time ----------
App.Activation._profile = (id, roll, stub) => ({
  role: "Student", name: "", roll: String(roll), studentId: stub.studentId, studentDocId: stub.studentDocId,
  departmentId: stub.departmentId, loginId: id, active: true, mustChangePassword: false,
  createdAt: new Date().toISOString(), activatedBy: "self"
});
App.Activation.check = function ({ roll, dob, password, password2, pin }) {
  const id = App.Activation.idOf(roll);
  if (!id || !Auth.isValidLoginId(id)) return { error: "Enter your roll number." };
  const iso = App.Activation.parseDob(dob);
  if (!iso) return { error: "Enter your date of birth like 14-03-2005." };
  if (pin !== undefined && !/^\d{4}$/.test(pin)) return { error: "The PIN must be exactly 4 digits." };
  if (!password || password.length < 6) return { error: "The password must be at least 6 characters." };
  if (password !== password2) return { error: "The two passwords are not the same." };
  return { id, iso };
};

App.Activation.activate = async function (input) {
  const c = App.Activation.check(input);
  if (c.error) return { ok: false, error: c.error };
  const { id, iso } = c;
  let stub;
  try {
    const snap = await db.collection("activation").doc(id).get();
    if (!snap.exists) return { ok: false, error: "There is no record for this roll number yet. Ask your department to add your date of birth, or to give you a login." };
    stub = snap.data();
  } catch (e) {
    return { ok: false, error: "Could not reach the server. Check your internet connection." };
  }
  if (stub.activated) return { ok: false, error: "This account is already activated. Log in with your password, or use \"Forgot password?\". If you never activated it yourself, tell your HOD." };

  let cred;
  try { cred = await auth.createUserWithEmailAndPassword(Auth.makeEmail(id), input.password); }
  catch (e) { return { ok: false, error: App.Accounts.errorText(e) }; }
  const uid = cred.user.uid, email = cred.user.email;
  try {
    const now = firebase.firestore.FieldValue.serverTimestamp();
    const b = db.batch();
    b.set(db.collection("activationClaims").doc(uid), { roll: id, dob: iso, at: now });
    b.set(db.collection("users").doc(uid), App.Activation._profile(id, input.roll, stub));
    b.set(db.collection("loginNames").doc(id), { email, uid, departmentId: stub.departmentId });
    b.update(db.collection("students").doc(stub.studentDocId), { uid, loginId: id });
    b.update(db.collection("activation").doc(id), { activated: true, hasPin: true, activatedAt: now });
    b.update(db.collection("studentSecrets").doc(id), { pinHash: await App.Activation.hash(`${id}|${input.pin}`), activatedAt: now, activatedUid: uid });
    await b.commit();
  } catch (e) {
    console.warn("activation refused", e);
    await cred.user.delete().catch(() => {});
    await auth.signOut().catch(() => {});
    return { ok: false, error: "The roll number and date of birth don't match our records. Check them and try again, or ask your HOD." };
  }
  await db.collection("activationClaims").doc(uid).delete().catch(() => {});
  await auth.signOut().catch(() => {});
  return { ok: true, id };
};

// ---------- student: forgot password ----------
App.Activation.reset = async function (input) {
  const c = App.Activation.check(input);
  if (c.error) return { ok: false, error: c.error };
  const { id, iso } = c;
  let stub, oldUid;
  try {
    const [s, ln] = await Promise.all([db.collection("activation").doc(id).get(), db.collection("loginNames").doc(id).get()]);
    if (!s.exists) return { ok: false, error: "There is no record for this roll number. Ask your HOD to reset your password." };
    stub = s.data();
    oldUid = ln.exists ? ln.data().uid : null;
  } catch (e) {
    return { ok: false, error: "Could not reach the server. Check your internet connection." };
  }
  if (!stub.activated || !oldUid) return { ok: false, error: "This account is not activated yet. Use \"First time? Activate your account\"." };
  if (!stub.hasPin) return { ok: false, error: "No PIN has been set for this account. Ask your HOD to reset your password." };

  let cred;
  try { cred = await auth.createUserWithEmailAndPassword(Auth.makeEmail(id), input.password); }
  catch (e) { return { ok: false, error: App.Accounts.errorText(e) }; }
  const uid = cred.user.uid, email = cred.user.email;
  try {
    const now = firebase.firestore.FieldValue.serverTimestamp();
    const b = db.batch();
    b.set(db.collection("activationClaims").doc(uid), { roll: id, dob: iso, pin: input.pin, at: now });
    b.set(db.collection("users").doc(uid), App.Activation._profile(id, input.roll, stub));
    b.update(db.collection("loginNames").doc(id), { email, uid });
    b.update(db.collection("students").doc(stub.studentDocId), { uid });
    b.update(db.collection("users").doc(oldUid), { active: false });       // the old password stops working
    b.update(db.collection("studentSecrets").doc(id), { activatedAt: now, activatedUid: uid });
    await b.commit();
  } catch (e) {
    console.warn("reset refused", e);
    await cred.user.delete().catch(() => {});
    await auth.signOut().catch(() => {});
    return { ok: false, error: "The roll number, date of birth or PIN doesn't match. Check them and try again, or ask your HOD." };
  }
  await db.collection("activationClaims").doc(uid).delete().catch(() => {});
  await auth.signOut().catch(() => {});
  return { ok: true, id };
};

// ---------- student: choose a PIN (students who got a login from the HOD, or after an HOD reset) ----------
App.Activation.ensurePin = async function () {
  const user = Auth.currentUser();
  if (!user || user.role !== "Student" || !user.loginId || App.Activation._asked) return;
  let stub;
  try {
    const snap = await db.collection("activation").doc(user.loginId).get();
    if (!snap.exists) return;                 // no date of birth on record: PIN can't be used
    stub = snap.data();
  } catch (e) { return; }
  if (stub.hasPin) return;
  App.Activation._asked = true;               // once per visit
  const pin = await UI.prompt("Choose a 4-digit PIN.\n\nIf you ever forget your password, your roll number, date of birth and this PIN " +
    "let you choose a new one yourself. Keep it private.", { title: "Set your PIN", placeholder: "4 digits" });
  if (pin === null) return;
  if (!/^\d{4}$/.test(pin.trim())) { await UI.alert("The PIN must be exactly 4 digits. You'll be asked again next time."); return; }
  try {
    const b = db.batch();
    b.update(db.collection("studentSecrets").doc(user.loginId), { pinHash: await App.Activation.hash(`${user.loginId}|${pin.trim()}`) });
    b.update(db.collection("activation").doc(user.loginId), { hasPin: true });
    await b.commit();
    await UI.alert("PIN saved.");
  } catch (e) {
    console.warn(e);
    await UI.alert("The PIN could not be saved. You'll be asked again next time.");
  }
};

// ---------- login screen ----------
document.addEventListener("DOMContentLoaded", () => {
  const q = id => document.getElementById(id);
  const toggle = (link, panel) => { if (q(link) && q(panel)) q(link).onclick = e => { e.preventDefault(); q(panel).style.display = q(panel).style.display === "none" ? "block" : "none"; }; };
  toggle("activateLink", "activatePanel");
  const val = id => (q(id) ? q(id).value : "");
  const signIn = async (id, password) => {          // log in with the new password, as from the login form
    q("loginUsername").value = id;
    q("loginPassword").value = password;
    q("loginBtn").click();
  };
  const run = async (btn, msg, fn, done) => {
    q(msg).style.color = "#555"; q(msg).textContent = "Please wait…";
    q(btn).disabled = true;
    const res = await fn();
    q(btn).disabled = false;
    if (!res.ok) { q(msg).style.color = "red"; q(msg).textContent = res.error; return; }
    q(msg).style.color = "green"; q(msg).textContent = done;
    await signIn(res.id, fn.password);
  };
  if (q("actBtn")) q("actBtn").onclick = () => {
    const input = { roll: val("actRoll"), dob: val("actDob"), password: val("actPw"), password2: val("actPw2"), pin: val("actPin").trim() };
    const fn = () => App.Activation.activate(input);
    fn.password = input.password;
    run("actBtn", "actMsg", fn, "Activated. Logging you in…");
  };
  if (q("stuResetBtn")) q("stuResetBtn").onclick = () => {
    const input = { roll: val("resRoll"), dob: val("resDob"), pin: val("resPin").trim(), password: val("resPw"), password2: val("resPw2") };
    const fn = () => App.Activation.reset(input);
    fn.password = input.password;
    run("stuResetBtn", "resMsg", fn, "Password changed. Logging you in…");
  };
});
