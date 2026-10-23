// Shared by backup.mjs and restore.mjs: connecting, and turning Firestore values
// into plain JSON and back without losing their type (a date must come back as
// a Firestore timestamp, not as text, or the database rules will reject it).
import admin from "firebase-admin";
import fs from "node:fs";

export const FORMAT = "attendance-backup";
export const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
export const flag = name => process.argv.includes(name);

export function connect(usage) {
  const keyFile = arg("--key");
  if (keyFile) {
    const key = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    admin.initializeApp({ credential: admin.credential.cert(key), projectId: key.project_id });
  } else if (process.env.FIRESTORE_EMULATOR_HOST && arg("--project")) {
    admin.initializeApp({ projectId: arg("--project") });       // local testing
  } else {
    console.error(usage);
    process.exit(1);
  }
  return { db: admin.firestore(), projectId: admin.app().options.projectId };
}

const { Timestamp, GeoPoint, DocumentReference } = admin.firestore;

// Firestore value -> JSON. Special values become { "$type": ..., ... }.
export function encode(v) {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : { $type: "number", v: String(v) };
  if (v instanceof Timestamp) return { $type: "timestamp", s: v.seconds, n: v.nanoseconds };
  if (v instanceof GeoPoint) return { $type: "geopoint", lat: v.latitude, lng: v.longitude };
  if (v instanceof DocumentReference) return { $type: "ref", path: v.path };
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { $type: "bytes", b64: Buffer.from(v).toString("base64") };
  if (Array.isArray(v)) return v.map(encode);
  if (typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = encode(x);
    return "$type" in v ? { $type: "map", v: out } : out;       // a real field named "$type" stays a field
  }
  throw new Error(`Unsupported value: ${typeof v}`);
}

export function decode(v, db) {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(x => decode(x, db));
  switch (v.$type) {
    case undefined: break;
    case "number": return Number(v.v);
    case "timestamp": return new Timestamp(v.s, v.n);
    case "geopoint": return new GeoPoint(v.lat, v.lng);
    case "ref": return db.doc(v.path);
    case "bytes": return Buffer.from(v.b64, "base64");
    case "map": { const out = {}; for (const [k, x] of Object.entries(v.v)) out[k] = decode(x, db); return out; }
    default: throw new Error(`Unknown value type in backup: ${v.$type}`);
  }
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = decode(x, db);
  return out;
}

// Every document of one collection, a page at a time (keeps memory use small)
export async function* eachDoc(db, collection) {
  let last = null;
  for (;;) {
    let q = db.collection(collection).orderBy(admin.firestore.FieldPath.documentId()).limit(500);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    for (const d of snap.docs) yield d;
    if (snap.size < 500) return;
    last = snap.docs[snap.docs.length - 1].id;
  }
}

// Same content? (compares the encoded form, so types count too)
export const sameData = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map(k => [k, sortKeys(v[k])]));
  return v;
}
