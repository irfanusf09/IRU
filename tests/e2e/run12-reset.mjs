import path from "path";
import { execFileSync } from "node:child_process";
import { TOOLS } from "./paths.mjs";
const env = { ...process.env, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" };
const run = (dir, args) => { try { return execFileSync("node", args, { cwd: dir, env, encoding: "utf8" }); } catch (e) { return (e.stdout || "") + (e.stderr || ""); } };
let fails = 0; const check = (n, c, x = "") => { console.log(c ? "  PASS" : "  FAIL", n, x); if (!c) fails++; };
const signIn = async (email, password) => (await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake",
  { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }) })).ok;

run(path.join(TOOLS, "demo-seed"), ["seed.mjs", "--project", "demo-attendance"]);
const list = run(path.join(TOOLS, "reset-login"), ["reset.mjs", "--project", "demo-attendance"]);
check("lists the Admin, Principal and HOD login IDs", /Inst\. Admin\s+admin/.test(list) && /Principal\s+principal/.test(list) && /HOD\s+hod\.eco/.test(list), "\n" + list);
const out = run(path.join(TOOLS, "reset-login"), ["reset.mjs", "--project", "demo-attendance", "--login", "admin"]);
const pw = (out.match(/Password:\s+(\S+)/) || [])[1];
check("sets a new password", !!pw, out);
check("new password works, old one doesn't", await signIn("admin.demo@users.attendance.example.com", pw) && !(await signIn("admin.demo@users.attendance.example.com", "demo1234")));
const bad = run(path.join(TOOLS, "reset-login"), ["reset.mjs", "--project", "demo-attendance", "--login", "nobody"]);
check("unknown login ID explained", /No login ID "nobody"/.test(bad), bad.trim());
console.log(fails ? "FAILED" : "ALL CHECKS PASSED"); process.exit(fails ? 1 : 0);
