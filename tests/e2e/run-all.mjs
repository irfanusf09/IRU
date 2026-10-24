// Runs every browser check in turn against the Firestore + Auth emulators,
// emptying the emulators before each one. Started by "npm test" (see README).
import { spawnSync } from "node:child_process";
import fs from "fs"; import path from "path";
import { HERE, TOOLS } from "./paths.mjs";

const PROJECT = "demo-attendance";
const RUNS = ["run.mjs", "run2.mjs", "run3.mjs", "run4.mjs", "run5-excel.mjs", "run6-multi.mjs", "run7-upgrade.mjs",
  "run8-security.mjs", "run9-demo.mjs", "run10-edit.mjs", "run11-ids.mjs", "run12-reset.mjs", "run14-lazy.mjs", "run15-offline.mjs", "run16-backup.mjs", "run17-appcheck.mjs", "run18-handover.mjs"];
const only = process.argv.slice(2);

for (const tool of ["demo-seed", "reset-login", "backup"]) {
  if (!fs.existsSync(path.join(TOOLS, tool, "node_modules"))) {
    console.error(`tools/${tool} needs "npm install" first (some checks use it).`);
    process.exit(1);
  }
}

async function wipe() {
  await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  await fetch(`http://127.0.0.1:9099/emulator/v1/projects/${PROJECT}/accounts`, { method: "DELETE" });
}

const failed = [];
for (const run of RUNS.filter(r => !only.length || only.some(o => r.includes(o)))) {
  await wipe();
  console.log(`\n========== ${run} ==========`);
  const r = spawnSync("node", [run], { cwd: HERE, stdio: "inherit", timeout: 10 * 60 * 1000 });
  if (r.status !== 0) failed.push(run);
}
console.log(failed.length ? `\nFAILED: ${failed.join(", ")}` : "\nALL BROWSER CHECKS PASSED");
process.exit(failed.length ? 1 : 0);
