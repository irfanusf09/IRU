// =====================================================================
// Project owner's tool: when someone (e.g. the Institution Admin) has
// forgotten their login, look up the login IDs and give a new password.
// Needs the project's private key, so only the Firebase project owner can
// use it.
//
//   1. Firebase console -> Project settings -> Service accounts ->
//      "Generate new private key". Keep that file private; delete it after.
//   2. cd tools/reset-login && npm install
//   3. Show the Admin, Principal and HOD login IDs:
//        node reset.mjs --key /path/to/key.json
//      Give a login a new password (they choose their own at next login):
//        node reset.mjs --key /path/to/key.json --login admin
// =====================================================================
import admin from "firebase-admin";
import crypto from "node:crypto";
import fs from "node:fs";

const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const keyFile = arg("--key");
if (keyFile) {
  const key = JSON.parse(fs.readFileSync(keyFile, "utf8"));
  admin.initializeApp({ credential: admin.credential.cert(key), projectId: key.project_id });
} else if (process.env.FIRESTORE_EMULATOR_HOST && arg("--project")) {
  admin.initializeApp({ projectId: arg("--project") });         // local testing
} else {
  console.error("Usage: node reset.mjs --key /path/to/key.json [--login <login ID>]");
  process.exit(1);
}
const db = admin.firestore();
const projectId = admin.app().options.projectId;
const loginId = (arg("--login") || "").trim().toLowerCase();

if (!loginId) {
  console.log(`Logins in "${projectId}" (Institution Admin, Principal, HODs):`);
  const snap = await db.collection("users").where("role", "in", ["Admin", "Principal", "HOD"]).get();
  const rows = snap.docs.map(d => d.data()).sort((a, b) => String(a.role).localeCompare(String(b.role)));
  if (!rows.length) console.log("  (none found)");
  rows.forEach(u => console.log(`  ${(u.role === "Admin" ? "Inst. Admin" : u.role).padEnd(12)} ${String(u.loginId || "?").padEnd(18)} ${u.name || ""}` +
    `${u.departmentId ? "  [" + u.departmentId + "]" : ""}${u.active === false ? "  (deactivated)" : ""}`));
  console.log("\nTo give one of them a new password:  node reset.mjs --key <key.json> --login <login ID>");
  process.exit(0);
}

const ln = await db.doc(`loginNames/${loginId}`).get();
if (!ln.exists) { console.error(`No login ID "${loginId}" in "${projectId}". Run without --login to see the IDs.`); process.exit(1); }
const { uid } = ln.data();
const profileRef = db.doc(`users/${uid}`);
const profile = await profileRef.get();
if (!profile.exists) { console.error(`Login "${loginId}" has no profile; ask the developer.`); process.exit(1); }

const chars = "abcdefghjkmnpqrstuvwxyz23456789";                // no look-alikes
const password = Array.from(crypto.randomBytes(10), b => chars[b % chars.length]).join("");
await admin.auth().updateUser(uid, { password, disabled: false });
await profileRef.update({ mustChangePassword: true, active: true });

const p = profile.data();
console.log(`New password set for ${p.name || loginId} (${p.role === "Admin" ? "Institution Admin" : p.role}) in "${projectId}".\n`);
console.log(`  Login ID:  ${loginId}`);
console.log(`  Password:  ${password}\n`);
console.log("They will be asked to choose their own password when they log in.");
console.log("Tip: once logged in, set a recovery email (menu -> Recovery Email) so this isn't needed again.");
process.exit(0);
