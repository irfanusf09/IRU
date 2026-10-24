// One active HOD per department and one Principal; "Hand over" gives the
// successor the same login ID while the former holder's account and records stay.
import { start } from "./harness.mjs";
import { execFileSync } from "node:child_process";
import path from "path";
import { TOOLS } from "./paths.mjs";
const h = await start();
const { page, check, log, admin } = h;
const env = { ...process.env, FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080", FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" };
execFileSync("node", ["seed.mjs", "--project", "demo-attendance"], { cwd: path.join(TOOLS, "demo-seed"), env });
const read = async fn => { let v; await admin(async db => { v = await fn(db); }); return v; };
const users = () => read(async db => (await db.collection("users").where("role", "in", ["HOD", "Principal"]).get()).docs.map(d => ({ uid: d.id, ...d.data() })));
const rows = () => page.$$eval("#leaderList tr", trs => trs.slice(1).map(tr => tr.textContent.replace(/\s+/g, " ").trim()));
const accounts = async () => { await page.click("#instTabs button[data-tab=accounts]"); await page.waitForFunction(() => document.querySelectorAll("#leaderList tr").length > 1); };

log("Institution Admin: a second HOD or Principal is refused");
await h.login("admin", "demo1234");
await accounts();
const ecoHod = (await users()).find(u => u.role === "HOD" && u.departmentId === "economics");
await page.selectOption("#leaderRole", "HOD"); await page.selectOption("#leaderDept", "economics");
await page.fill("#leaderName", "Second Eco"); await page.fill("#leaderLoginId", "hod.eco2"); await page.click("#addLeaderBtn");
let msg = await h.alertText();
check("second HOD for Economics refused, Hand over suggested", /already/.test(msg) && /Hand over/.test(msg), msg.slice(0, 120));
await page.selectOption("#leaderRole", "Principal");
await page.fill("#leaderName", "Second Principal"); await page.fill("#leaderLoginId", "principal2"); await page.click("#addLeaderBtn");
msg = await h.alertText();
check("second Principal refused", /already/.test(msg), msg.slice(0, 80));
check("neither was created", !(await users()).some(u => /^Second/.test(u.name)));

log("Hand over Economics HOD");
await page.click(`button[data-handover="${ecoHod.uid}"]`);
await page.waitForSelector("#uiDialog.open .ui-input"); await page.fill("#uiDialog.open .ui-input", "Dr New Eco"); await h.ok();
await h.dialog(); await h.ok();                                    // confirm
msg = await h.alertText();
const newPw = (msg.match(/Starting password: (\S+)/) || [])[1];
check("successor gets the same login ID and a password", /Login ID: hod\.eco\b/.test(msg) && !!newPw, msg.slice(0, 120));
await page.waitForFunction(() => /Dr New Eco/.test(document.getElementById("leaderList").textContent));
// (the demo HOD is named "HOD Economics", which is also the Role + Department text, so rows are told apart by account)
const rowOf = uid => page.$eval(`#leaderList button[data-active="${uid}"]`, b => b.closest("tr").textContent.replace(/\s+/g, " ").trim()).catch(() => null);
let r = await rows();
check("list shows the new HOD, not the former one", r.some(x => /Dr New Eco/.test(x) && /hod\.eco /.test(x + " ")) && (await rowOf(ecoHod.uid)) === null, JSON.stringify(r));
check("former one is behind a link", /Show former \(1\)/.test(await page.textContent("#leaderList")));
await page.click("#toggleFormerLeaders");
await page.waitForSelector(`#leaderList button[data-active="${ecoHod.uid}"]`);
const formerRow = (await rowOf(ecoHod.uid)) || "";
check("former row: archive login ID, until today, then the successor", /hod\.eco\.until-\d{4}-\d{2}-\d{2}/.test(formerRow) && /then Dr New Eco/.test(formerRow), formerRow);
await page.click(`button[data-active="${ecoHod.uid}"]`);
msg = await h.alertText();
check("former HOD can't be reactivated while the successor is active", /can't be reactivated/.test(msg), msg.slice(0, 100));
const old = (await users()).find(u => u.uid === ecoHod.uid);
const nu = (await users()).find(u => u.name === "Dr New Eco");
check("records: former keeps their name, successor knows who they took over from",
  old.active === false && old.name === ecoHod.name && old.formerLoginId === "hod.eco" && old.handedOverTo === "Dr New Eco" &&
  nu.loginId === "hod.eco" && nu.departmentId === "economics" && nu.tookOverFrom === ecoHod.name, JSON.stringify({ old, nu }).slice(0, 300));
await h.logout();

log("Logins after the hand-over");
await page.goto("http://localhost:5555/");
await page.waitForSelector("#loginScreen", { state: "visible" });
await page.fill("#loginUsername", "hod.eco"); await page.fill("#loginPassword", "demo1234"); await page.click("#loginBtn");
await page.waitForFunction(() => document.getElementById("loginError").textContent.length > 0);
check("former HOD's old password no longer opens hod.eco", /incorrect/i.test(await page.textContent("#loginError")));
await page.fill("#loginUsername", old.loginId); await page.fill("#loginPassword", "demo1234"); await page.click("#loginBtn");
await page.waitForFunction(() => /deactivated/i.test(document.getElementById("loginError").textContent));
check("former HOD's account exists but is deactivated", true);
h.errors.splice(0, h.errors.length, ...h.errors.filter(e => !/status of 400/.test(e)));   // the two refused logins above
await h.loginFirst("hod.eco", newPw);
await page.waitForSelector("#hodDashboardSection.active");
check("successor is HOD of Economics", /Economics/.test(await page.textContent("#appContainer")));

log("New records name the person");
await page.evaluate(() => showSection("adminSection")); await page.click("#adminTabs button[data-tab=closures]");
await page.fill("#closedDayDate", "2026-09-15"); await page.fill("#closedDayReason", "Hand-over test"); await page.click("#addClosedDayBtn");
await page.waitForFunction(() => /Hand-over test/.test(document.getElementById("closedDayList").textContent));
const day = await read(async db => (await db.collection("dayStatuses").where("reason", "==", "Hand-over test").get()).docs[0].data());
check("closed day records 'Dr New Eco (hod.eco)'", day.markedBy === "Dr New Eco (hod.eco)", day.markedBy);
await h.finish();
