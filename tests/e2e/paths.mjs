// Where things are, relative to this folder, so the tests run from any checkout.
import path from "path"; import fs from "fs"; import os from "os"; import { fileURLToPath } from "url";
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "../..");
export const PUBLIC = path.join(ROOT, "public");
export const RULES = path.join(ROOT, "firestore.rules");
export const TOOLS = path.join(ROOT, "tools");
export const FB = path.join(HERE, "node_modules/firebase");
export const XLSX_FILE = path.join(HERE, "node_modules/@e965/xlsx/dist/xlsx.full.min.js");
// Screenshots (kept between runs, not committed) and scratch files
export const SHOTS = path.join(HERE, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
export const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "attendance-e2e-"));
