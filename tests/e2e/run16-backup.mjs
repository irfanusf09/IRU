// Backup -> wipe -> restore gives back exactly the same database (types included),
// refuses damaged files and non-empty databases, and --missing-only only fills gaps.
import { start } from "./harness.mjs";
import { execFileSync } from "node:child_process";
import fs from "fs"; import path from "path"; import zlib from "zlib";
import { TOOLS, TMP } from "./paths.mjs";
const h = await start();
const { page, check, log } = h;
const env = { ...process.env, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" };
const BK = path.join(TOOLS, "backup");
const run = args => { try { return { code: 0, out: execFileSync("node", args, { cwd: BK, env, encoding: "utf8" }) }; }
                      catch (e) { return { code: e.status, out: (e.stdout || "") + (e.stderr || "") }; } };
// a few lines of firebase-admin, run in the backup tool's folder
const adminJs = code => execFileSync("node", ["--input-type=module", "-e",
  `import admin from "firebase-admin"; admin.initializeApp({ projectId: "demo-attendance" }); const db = admin.firestore(); ${code}`],
  { cwd: BK, env, encoding: "utf8" });
const wipe = () => fetch("http://127.0.0.1:8080/emulator/v1/projects/demo-attendance/databases/(default)/documents", { method: "DELETE" });
const P = ["--project", "demo-attendance"];
const docsOf = file => zlib.gunzipSync(fs.readFileSync(file)).toString().trim().split("\n").map(l => JSON.parse(l)).filter(r => r.c);
const key = r => `${r.c}/${r.id}`;

log("demo data plus awkward values");
execFileSync("node", ["seed.mjs", ...P], { cwd: path.join(TOOLS, "demo-seed"), env });
adminJs(`await db.doc("zzTypes/one").set({ savedAt: admin.firestore.Timestamp.fromMillis(1760000000123), present: 7, half: 2.5,
  big: 1760000002000.5, inf: Infinity, $type: "a field called $type", nested: { $type: "x", list: [1, "a", null, { d: admin.firestore.Timestamp.fromMillis(5) }] },
  geo: new admin.firestore.GeoPoint(34.08, 74.79), ref: db.doc("departments/economics"), bytes: Buffer.from([0, 1, 255]) });`);

log("backup");
const A = path.join(TMP, "a.json.gz"), B = path.join(TMP, "b.json.gz");
let r = run(["backup.mjs", ...P, "--out", A]);
check("backup finished", r.code === 0 && fs.existsSync(A) && !fs.existsSync(A + ".part"), r.out.slice(-300));
const before = docsOf(A);
check("backup has the demo data", before.length > 500 && before.some(d => d.c === "attendance"), `${before.length} docs`);

log("refusals");
const lines = zlib.gunzipSync(fs.readFileSync(A)).toString().trim().split("\n");
const cut = path.join(TMP, "cut.json.gz");
fs.writeFileSync(cut, zlib.gzipSync(lines.slice(0, -5).join("\n") + "\n"));
r = run(["restore.mjs", ...P, "--file", cut, "--yes", "demo-attendance"]);
check("incomplete file refused", r.code === 1 && /incomplete/.test(r.out), r.out.slice(-200));
r = run(["restore.mjs", ...P, "--file", A, "--yes", "demo-attendance"]);
check("non-empty database refused", r.code === 1 && /not empty/.test(r.out) && /Nothing was changed/.test(r.out), r.out.slice(-200));

log("wipe, then restore");
await wipe();
r = run(["restore.mjs", ...P, "--file", A]);
const empty = adminJs(`console.log((await db.collection("attendance").limit(1).get()).size);`).trim();
check("without --yes nothing is written", r.code === 0 && /Nothing was changed/.test(r.out) && empty === "0", r.out.slice(-200));
r = run(["restore.mjs", ...P, "--file", A, "--yes", "wrong-project"]);
check("wrong project name in --yes does nothing", /Nothing was changed/.test(r.out));
r = run(["restore.mjs", ...P, "--file", A, "--yes", "demo-attendance"]);
check("restore finished and verified", r.code === 0 && /checked each one/.test(r.out), r.out.slice(-300));

log("restored database = original");
run(["backup.mjs", ...P, "--out", B]);
const after = docsOf(B);
const mapA = new Map(before.map(d => [key(d), JSON.stringify(d.d)])), mapB = new Map(after.map(d => [key(d), JSON.stringify(d.d)]));
const diff = [...mapA.keys()].filter(k => mapA.get(k) !== mapB.get(k));
check("same documents, same content", mapA.size === mapB.size && diff.length === 0, `${mapA.size} vs ${mapB.size}, differ: ${diff.slice(0, 3)}`);
const types = JSON.parse(adminJs(`const d = (await db.doc("zzTypes/one").get()).data();
  console.log(JSON.stringify({ ts: d.savedAt instanceof admin.firestore.Timestamp && d.savedAt.toMillis() === 1760000000123,
    nestedTs: d.nested.list[3].d instanceof admin.firestore.Timestamp, int: d.present === 7, half: d.half === 2.5, big: d.big === 1760000002000.5,
    inf: d.inf === Infinity, field: d.$type === "a field called $type" && d.nested.$type === "x",
    geo: d.geo instanceof admin.firestore.GeoPoint, ref: d.ref.path === "departments/economics", bytes: Buffer.from(d.bytes).equals(Buffer.from([0, 1, 255])) }));`));
check("dates come back as timestamps, numbers and other types intact", Object.values(types).every(Boolean), JSON.stringify(types));

log("the app works on the restored database");
await h.login("hod.eco", "demo1234");
await page.waitForFunction(() => /Classes Today/.test(document.getElementById("hodStatsWidget").textContent));
check("HOD dashboard loads", true);
await h.logout();

log("--missing-only");
const gone = before.filter(d => d.c === "attendance").slice(0, 2);
adminJs(`await db.doc("${key(gone[0])}").delete(); await db.doc("${key(gone[1])}").delete();
  await db.doc("departments/economics").update({ name: "Changed after backup" });`);
r = run(["restore.mjs", ...P, "--file", A, "--missing-only", "--yes", "demo-attendance"]);
check("puts back the 2 deleted documents only", r.code === 0 && /Would write 2 documents/.test(r.out) && /Restored 2 documents/.test(r.out), r.out.slice(-300));
const now = JSON.parse(adminJs(`console.log(JSON.stringify({ back: (await db.doc("${key(gone[0])}").get()).exists && (await db.doc("${key(gone[1])}").get()).exists,
  name: (await db.doc("departments/economics").get()).data().name }));`));
check("deleted ones are back, newer changes kept", now.back && now.name === "Changed after backup", JSON.stringify(now));
await h.finish();
