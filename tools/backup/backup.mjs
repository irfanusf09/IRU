// =====================================================================
// Project owner's tool: copy the whole database (every collection) into
// one file on this computer. restore.mjs puts it back.
// Logins (passwords) live in Firebase Authentication, not in the database,
// and are not in this file; a restore keeps working with the existing logins.
//
//   1. Firebase console -> Project settings -> Service accounts ->
//      "Generate new private key". Keep that file private; delete it after.
//   2. cd tools/backup && npm install
//   3. node backup.mjs --key /path/to/key.json
//      -> attendance-backup_<project>_<date-time>.json.gz in this folder
//      (or choose:  --out /path/to/file.json.gz)
//
// Every document is read once: on the free plan a large database can use up
// the day's free reads (50,000), so run it after college hours.
// =====================================================================
import fs from "node:fs";
import zlib from "node:zlib";
import { once } from "node:events";
import { FORMAT, arg, connect, encode, eachDoc } from "./common.mjs";

const { db, projectId } = connect("Usage: node backup.mjs --key /path/to/key.json [--out file.json.gz]");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outFile = arg("--out") || `attendance-backup_${projectId}_${stamp}.json.gz`;
const partFile = outFile + ".part";              // renamed only when complete

const collections = (await db.listCollections()).map(c => c.id).sort();
const gz = zlib.createGzip();
const file = fs.createWriteStream(partFile);
gz.pipe(file);
const write = async obj => { if (!gz.write(JSON.stringify(obj) + "\n")) await once(gz, "drain"); };

console.log(`Backing up "${projectId}" (${collections.length} collections)…`);
await write({ format: FORMAT, version: 1, project: projectId, takenAt: new Date().toISOString(), collections });
const counts = {};
let nested = 0;
for (const c of collections) {
  counts[c] = 0;
  for await (const d of eachDoc(db, c)) {
    await write({ c, id: d.id, d: encode(d.data()) });
    counts[c]++;
  }
  console.log(`  ${c.padEnd(24)} ${counts[c]}`);
}
// The app keeps no collections inside documents; say so if someone added one
for (const c of collections) {
  const sample = await db.collection(c).limit(20).get();
  for (const d of sample.docs) nested += (await d.ref.listCollections()).length;
}
await write({ end: true, counts, total: Object.values(counts).reduce((a, b) => a + b, 0) });
gz.end();
await once(file, "finish");
fs.renameSync(partFile, outFile);

console.log(`\nSaved ${Object.values(counts).reduce((a, b) => a + b, 0)} documents to ${outFile}`);
if (nested) console.log("WARNING: some documents have collections inside them; those are NOT in this backup. Tell the developer.");
console.log("Keep this file somewhere safe (not only on this computer). It contains everyone's records.");
