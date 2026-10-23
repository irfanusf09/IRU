// =====================================================================
// Project owner's tool: put a backup made by backup.mjs back into a project.
//
//   cd tools/backup && npm install
//   See what it would do (changes nothing):
//     node restore.mjs --key /path/to/key.json --file <backup.json.gz>
//   Then, to really restore, add --yes and the project ID:
//     node restore.mjs --key key.json --file <backup> --yes <project-id>
//
// Two ways, neither ever overwrites or deletes anything:
//   (normal)        into an EMPTY database, e.g. after it was wiped, or a new project
//   --missing-only  into a database in use: puts back only documents that are
//                   missing (deleted by mistake); existing ones are left as they are
// Afterwards every restored document is read back and compared with the backup.
// =====================================================================
import fs from "node:fs";
import zlib from "node:zlib";
import readline from "node:readline";
import { FORMAT, arg, flag, connect, decode, sameData, encode } from "./common.mjs";

const usage = "Usage: node restore.mjs --key /path/to/key.json --file <backup.json.gz> [--missing-only] [--yes <project-id>]";
const { db, projectId } = connect(usage);
const fileName = arg("--file");
if (!fileName || !fs.existsSync(fileName)) { console.error(usage); process.exit(1); }
const missingOnly = flag("--missing-only");
const confirmed = arg("--yes") === projectId;

// Read the whole file first: a damaged or incomplete file is refused before anything is written
async function readBackup() {
  const lines = readline.createInterface({ input: fs.createReadStream(fileName).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let header = null, footer = null; const docs = [];
  for await (const line of lines) {
    if (!line) continue;
    const row = JSON.parse(line);
    if (!header) { header = row; continue; }
    if (row.end) { footer = row; continue; }
    if (footer) throw new Error("data after the end marker");
    docs.push(row);
  }
  if (!header || header.format !== FORMAT) throw new Error("this is not a backup made by backup.mjs");
  if (header.version !== 1) throw new Error(`backup version ${header.version} is not supported`);
  if (!footer) throw new Error("the file is incomplete (no end marker) - the backup did not finish");
  if (footer.total !== docs.length) throw new Error(`the file says ${footer.total} documents but has ${docs.length}`);
  return { header, docs };
}

let backup;
try { backup = await readBackup(); }
catch (e) { console.error(`Cannot use ${fileName}: ${e.message}`); process.exit(1); }
const { header, docs } = backup;
const collections = [...new Set([...header.collections, ...docs.map(d => d.c)])];

console.log(`Backup of "${header.project}" taken ${header.takenAt}: ${docs.length} documents.`);
console.log(`Restore into: "${projectId}"${missingOnly ? " (only missing documents)" : ""}`);
if (header.project !== projectId) console.log(`NOTE: the backup is from a different project ("${header.project}").`);

// What is there now?
const existing = {};
for (const c of collections) existing[c] = (await db.collection(c).limit(1).get()).size;
const nonEmpty = collections.filter(c => existing[c]);
if (!missingOnly && nonEmpty.length) {
  console.error(`\nNot restoring: the database is not empty (${nonEmpty.join(", ")}).`);
  console.error("Nothing was changed. To put back only deleted documents, add --missing-only.");
  process.exit(1);
}

// Which documents would be written?
let toWrite = docs;
if (missingOnly) {
  toWrite = [];
  for (let i = 0; i < docs.length; i += 300) {
    const part = docs.slice(i, i + 300);
    const snaps = await db.getAll(...part.map(d => db.collection(d.c).doc(d.id)));
    snaps.forEach((s, k) => { if (!s.exists) toWrite.push(part[k]); });
  }
}
const per = {};
toWrite.forEach(d => { per[d.c] = (per[d.c] || 0) + 1; });
console.log(`\nWould write ${toWrite.length} documents:`);
Object.keys(per).sort().forEach(c => console.log(`  ${c.padEnd(24)} ${per[c]}`));
if (!toWrite.length) { console.log("Nothing to do."); process.exit(0); }
if (!confirmed) {
  console.log(`\nNothing was changed. To do it, run the same command with:  --yes ${projectId}`);
  process.exit(0);
}

// Write: create() never replaces a document, even if one appears meanwhile
const writer = db.bulkWriter();
let failed = 0;
writer.onWriteError(err => { if (err.code === 6 /* ALREADY_EXISTS */) { failed++; return false; } return err.failedAttempts < 5; });
for (const d of toWrite) writer.create(db.collection(d.c).doc(d.id), decode(d.d, db)).catch(() => {});
await writer.close();

// Read everything back and compare
let bad = 0;
for (let i = 0; i < toWrite.length; i += 300) {
  const part = toWrite.slice(i, i + 300);
  const snaps = await db.getAll(...part.map(d => db.collection(d.c).doc(d.id)));
  snaps.forEach((s, k) => {
    if (!s.exists || !sameData(encode(s.data()), part[k].d)) { bad++; if (bad <= 10) console.error(`  differs: ${part[k].c}/${part[k].id}`); }
  });
}
if (bad || failed) {
  console.error(`\nRestore finished with problems: ${bad} document(s) differ from the backup. Tell the developer.`);
  process.exit(1);
}
console.log(`\nRestored ${toWrite.length} documents and checked each one against the backup. Logins were not touched.`);
