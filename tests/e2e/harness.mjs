// Shared setup for browser checks: Firestore + Auth emulators, the app served
// from public/, Firebase SDK from npm, and small helpers.
import { chromium } from "playwright";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import fs from "fs"; import path from "path";
import { PUBLIC, RULES, FB, XLSX_FILE, SHOTS } from "./paths.mjs";
export { SHOTS };

const TYPES = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };

// host: where the app is opened (App Check is skipped on localhost, so its test uses another name)
// appCheckKey: pretend a site key was filled in firebase-config.js
export async function start({ publicDir = PUBLIC, rules = RULES, timezoneId, viewport, latency = 0, host = "localhost:5555", appCheckKey = "" } = {}) {
  const BASE = `http://${host}/`;
  fs.mkdirSync(SHOTS, { recursive: true });
  const env = await initializeTestEnvironment({ projectId: "demo-attendance",
    firestore: { rules: fs.readFileSync(rules, "utf8"), host: "127.0.0.1", port: 8080 } });
  const admin = fn => env.withSecurityRulesDisabled(ctx => fn(ctx.firestore()));

  const browser = await chromium.launch({ args: ["--no-proxy-server",
    "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults"] });
  const ctx = await browser.newContext({ serviceWorkers: "block", acceptDownloads: true, ...(timezoneId ? { timezoneId } : {}), ...(viewport ? { viewport } : {}) });
  const page = await ctx.newPage();
  if (latency) await page.addInitScript(ms => { window.__LAT = ms; }, latency);
  const errors = [];
  let step = "start";
  page.on("pageerror", e => errors.push(`[${step}] pageerror: ` + e.message));
  page.on("console", m => { if (m.type() === "error" || /permission|denied|read failed|could not be loaded/i.test(m.text())) errors.push(`[${step}] ${m.type()}: ${m.text()}`); });

  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.hostname === "www.gstatic.com") return route.fulfill({ path: path.join(FB, path.basename(url.pathname)), contentType: "text/javascript" });
    if (url.hostname === "cdn.sheetjs.com") return route.fulfill({ path: XLSX_FILE, contentType: "text/javascript" });
    if (url.hostname === "cdn.jsdelivr.net" || url.hostname === "cdnjs.cloudflare.com") return route.fulfill({ body: "", contentType: "text/javascript" });
    // reCAPTCHA (App Check) can't be reached in tests: as if Google were unreachable
    if (/(^|\.)(google\.com|recaptcha\.net|gstatic\.com)$/.test(url.hostname)) return route.fulfill({ status: 503, body: "" });
    if (url.host === host) {
      if (url.pathname === "/firebase-config.js") return route.fulfill({ contentType: "text/javascript", body: `
        const firebaseConfig = { apiKey: "fake", authDomain: "demo-attendance.firebaseapp.com", projectId: "demo-attendance", appId: "1:1:web:1" };
        ${appCheckKey ? `const appCheckSiteKey = ${JSON.stringify(appCheckKey)};
        // Each App Check start is recorded with its key. reCAPTCHA (Google) can't be reached
        // from tests, so a stand-in gives a token at once, as reCAPTCHA would.
        window.__appCheck = [];
        firebase.appCheck.ReCaptchaV3Provider = function (key) {
          window.__appCheck.push(key);
          return new firebase.appCheck.CustomProvider({ getToken: async () => ({ token: "test-token", expireTimeMillis: Date.now() + 3600000 }) });
        };` : ""}
        (function () { const orig = firebase.initializeApp.bind(firebase);
          firebase.initializeApp = function (cfg, name) { const app = orig(cfg, name);
            app.firestore().useEmulator("127.0.0.1", 8080); app.auth().useEmulator("http://127.0.0.1:9099", { disableWarnings: true }); return app; }; })();
        // Optional: simulate network distance (window.__LAT ms per database read/save) and count reads
        (function () {
          const L = window.__LAT || 0;
          const label = o => { try {
              if (o.path) return o.path;
              const q = o._delegate && o._delegate._query;
              return q ? q.path.canonicalString() + (q.filters && q.filters.length ? "?" + q.filters.map(f => f.field.canonicalString() + f.op + JSON.stringify(f.value && (f.value.stringValue || f.value.integerValue || "…"))).join("&") : "") : "?";
            } catch (e) { return "?"; } };
          const wrap = (proto, name) => { const orig = proto[name]; proto[name] = function (...a) {
            window.__reads = (window.__reads || 0) + 1;
            (window.__log = window.__log || []).push([Math.round(performance.now()), name === "commit" ? "COMMIT" : label(this)]);
            return (L ? new Promise(r => setTimeout(r, L)) : Promise.resolve()).then(() => orig.apply(this, a)); }; };
          wrap(firebase.firestore.Query.prototype, "get");
          wrap(firebase.firestore.DocumentReference.prototype, "get");
          wrap(firebase.firestore.WriteBatch.prototype, "commit");
        })();` });
      const file = path.join(publicDir, url.pathname === "/" ? "index.html" : url.pathname);
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ path: file, contentType: TYPES[path.extname(file)] || "application/octet-stream" });
    }
    return route.continue();
  });

  let failures = 0;
  const h = {
    env, admin, browser, page, errors,
    log: (...a) => { step = a.join(" "); console.log("•", ...a); },
    check(name, cond, extra = "") { console.log(cond ? "  PASS" : "  FAIL", name, extra); if (!cond) failures++; },
    async signUp(email, password = "secret123") {
      const r = await fetch("http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=fake",
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
      return (await r.json()).localId;
    },
    async dialog() { await page.waitForSelector("#uiDialog.open"); return page.textContent("#uiDialog .ui-msg"); },
    async ok() { await page.click("#uiDialog.open .ui-ok"); await page.waitForTimeout(200); },
    async login(id, password = "secret123") {
      await page.goto(BASE);
      await page.waitForSelector("#loginScreen", { state: "visible" });
      await page.fill("#loginUsername", id); await page.fill("#loginPassword", password);
      await page.click("#loginBtn");
      try { await page.waitForSelector("#appContainer", { state: "visible", timeout: 10000 }); }
      catch (e) { console.log("LOGIN FAILED:", await page.textContent("#loginError"), "\n", errors.join("\n")); throw e; }
    },
    // First login with a starting password: choose a new one
    async loginFirst(id, password, newPassword = "secret123") {
      await page.goto(BASE);
      await page.waitForSelector("#loginScreen", { state: "visible" });
      await page.fill("#loginUsername", id); await page.fill("#loginPassword", password);
      await page.click("#loginBtn");
      await page.waitForSelector("#passwordPanel", { state: "visible", timeout: 10000 });
      await page.fill("#pwNew", newPassword); await page.fill("#pwConfirm", newPassword);
      await page.click("#pwSaveBtn");
      await page.waitForSelector("#appContainer", { state: "visible", timeout: 10000 });
    },
    // Text of the next in-app dialog, then press OK
    async alertText() { const t = await h.dialog(); await h.ok(); return t; },
    async logout() {
      if (await page.isVisible("#menuToggle") && !(await page.isVisible("#logoutBtn"))) await page.click("#menuToggle");
      await page.click("#logoutBtn"); await page.waitForLoadState("load"); await page.waitForTimeout(300);
    },
    async finish() {
      const real = errors.filter(e => !/Failed to load resource.*404|favicon|manifest/i.test(e));
      h.check("no errors in the browser console", real.length === 0, real.join("\n    "));
      await browser.close(); await env.cleanup();
      console.log(failures ? `\n${failures} check(s) FAILED` : "\nALL CHECKS PASSED");
      process.exit(failures ? 1 : 0);
    }
  };
  return h;
}
