# Attendance System

Attendance marking, registers and reports for a college — one department or many.
Installable on phones and computers (PWA).

Built with plain HTML/CSS/JavaScript on **Firebase** (Authentication, Firestore, Hosting).
There is no build step and no server code.

## Who does what

| Role | Sees | Does |
|------|------|------|
| **Institution Admin** | Every department | Adds departments; creates HOD and Principal logins; sets institution rules (casual leave limit); closes days for the whole institution; full backup |
| **Principal** | Every department, view only | Institution Dashboard: per day, classes held / not held / not marked, present / absent / leave, who took which class |
| **HOD** | Their department | Batches, subjects, teachers, students and their logins, closed days, correction decisions, reports, backup |
| **Teacher** | Their subjects | Marks attendance once per class per day (and can change it for a short while, see below), records leave, requests corrections |
| **Student** | Their own records | Dashboard and day-by-day register for all their subjects, from any department |

The database rules (`firestore.rules`) enforce this on Google's servers, not just on screen.

**Login IDs** are suggested by the app: students use their **roll number**; HODs
`hod.<department code>` (e.g. `hod.phy`); teachers `<code>.<first name>` (e.g. `phy.asha`,
then `phy.asha.bhat` or `phy.asha2` if taken). The Institution Admin sets each department's
short code. Logins created earlier keep their IDs.

**Changing saved attendance:** the teacher who saved a class can change its marks for a
while afterwards (late arrivals, mistakes) — 60 minutes by default, set by the Institution
Admin (0–180), and never past midnight. The first-saved marks are kept; changed entries
are marked **†** in registers. After that, corrections go to the HOD as before. Google's
servers check the time, so a phone's clock can't extend it.

A department can teach students of other departments (e.g. a Minor): its HOD uploads the
roll numbers, the students are found in their home department, and the offering HOD sees
their attendance in that subject. Roll numbers are unique in the institution; a student's
login ID is their roll number.

Running it for a single department is the same app with one department.

## Layout

| Path | What it is |
|------|------------|
| `public/index.html` | The whole app's screens |
| `public/app.js` | All app logic |
| `public/ui.js` | In-app dialogs and Admin Panel tabs |
| `public/pwa.js`, `public/sw.js`, `public/manifest.webmanifest` | Installable-app support |
| `public/firebase-config.js` | Which Firebase project the app talks to |
| `public/security-check.html` | Page that checks the database rules block what they should |
| `firestore.rules` | Database security rules (who may read/write what) |
| `firebase.json`, `.firebaserc` | Firebase Hosting / deploy settings |
| `tests/` | Automated tests of the database rules |
| `tests/e2e/` | Automated browser tests of the whole app |
| `.github/workflows/tests.yml` | Runs both test sets on GitHub for every pull request |
| `tools/demo-seed/` | Fills an empty project with a sample institution, for demonstrations |
| `tools/reset-login/` | Project owner's tool: look up login IDs and give a forgotten login a new password |
| `tools/backup/` | Project owner's tools: copy the whole database to a file, and put it back |

## Deploying

| Project | ID | Deploy with |
|---------|----|-------------|
| Real | `attendance-system-df860` | `firebase deploy` |
| Test | `attendance-system-demo-cbec9` | `firebase deploy -P test` |

Each deploy sends hosting + Firestore rules to that project.

`public/firebase-config.js` picks the project from the address the app is opened at:
the test project's addresses and `localhost` use **test**; everything else uses **real**.

## Starting

**A new project:** open the site and use **First-time setup (Institution Admin)** on the
login screen. Then, as Institution Admin: add the departments (Institution Setup →
Departments) and create each HOD's login. Each HOD then sets up their department as before.

**A project already used by one department (before departments existed):**

1. Deploy, then log in as the existing HOD. You will see only **Set up departments**:
   create the Institution Admin's login there (it is a separate login; note the password).
2. Log out, log in as the Institution Admin, choose a new password.
3. Institution Setup → Departments: add the department (e.g. Economics).
4. Institution Setup → **Old records** → *Move old records into this department*.
   Students also get their roll number as a login ID; their old IDs keep working.
5. Log in as the HOD again → Admin Panel → Settings → **Rebuild student copies**
   (this also fills the Principal's dashboard for past days).

Until step 4 is done, the old records can't be used.

## Tests

There are two sets. Both run against Google's emulators on your computer (never on a
real project) and need Node.js and Java.

**Database rules** — `tests/rules.test.mjs` checks `firestore.rules`:

```sh
cd tests
npm install
npm test
```

**Browser tests** — `tests/e2e/` opens the app in a real (hidden) browser and goes
through it as each role: logging in, marking, editing, leave, corrections, reports,
Excel uploads and downloads, departments and Minors, demo data, login IDs, lost
internet, backup and restore, App Check.

```sh
cd tools/demo-seed && npm install && cd ../reset-login && npm install && cd ../backup && npm install
cd ../../tests/e2e
npm install
npx playwright install chromium     # first time only: the test browser
npm test                            # a few minutes
```

`npm run speed` in `tests/e2e` times the main screens with a simulated distant database.

**On GitHub** both sets run by themselves for every pull request (and on `main`):
the pull request shows a green ✓ or a red ✗ next to "Tests". Merge only on green.

## Demo for the college

`tools/demo-seed/seed.mjs` fills an **empty** Firebase project with "Demo College":
four departments, HODs, teachers, a Principal, students taking Minors from other
departments, and three weeks of attendance (with leaves, defaulters, closed days, and
some of today's classes not yet marked). It refuses to run on a project that already
has data, and on the real project.

1. Create a separate Firebase project for the demo (the free plan is enough); enable
   Authentication → Email/Password; create a Firestore database; deploy the app and rules
   to it (add it to `.firebaserc` and `public/firebase-config.js` first).
2. Firebase console → Project settings → Service accounts → **Generate new private key**.
   Keep that file private and outside this folder.
3. Run:

   ```sh
   cd tools/demo-seed
   npm install
   node seed.mjs --key /path/to/key.json
   ```

It prints the demo logins (one shared password).

## Forgotten logins

- Anyone with a confirmed recovery email: **Forgot password?** on the login screen.
- Teachers and students: their HOD resets the password. HODs and the Principal: the
  Institution Admin.
- The Institution Admin (or anyone, if needed): the project owner runs `tools/reset-login`:

  1. Firebase console → Project settings → Service accounts → **Generate new private key**.
     Keep that file private and delete it afterwards.
  2. Run:

     ```sh
     cd tools/reset-login
     npm install
     node reset.mjs --key /path/to/key.json                  # shows Admin, Principal and HOD login IDs
     node reset.mjs --key /path/to/key.json --login admin    # gives that login a new password
     ```

  They choose their own password at the next login.

## Backups

The HOD's **Backup** download (Excel) is a readable copy for the department. To be able to
put the **whole database** back after an accident, the project owner uses `tools/backup`
(it needs the project's private key, like `tools/reset-login`):

```sh
cd tools/backup
npm install
node backup.mjs --key /path/to/key.json
```

This saves every collection into one file (`attendance-backup_<project>_<date>.json.gz`).
Keep copies somewhere safe, not only on one computer; the file contains everyone's
records. On the free plan a large database can use up the day's free reads (50,000), so
run it after college hours. Logins (passwords) are not in it and are not affected by a
restore. (On the Blaze plan, Google's own scheduled backups can also be turned on in the
Google Cloud console.)

**Putting it back** — first see what would happen (nothing is changed):

```sh
node restore.mjs --key /path/to/key.json --file attendance-backup_….json.gz
```

then repeat with `--yes <project-id>` to do it. It never overwrites or deletes anything:

- normally it restores only into an **empty** database (after a wipe, or into a new project);
- `--missing-only` puts back just the documents that were deleted, leaving everything
  else as it is now.

Every restored document is read back and compared with the backup. Damaged or
incomplete files are refused before anything is written. Try a restore on the **test**
project once, so you know the steps before you ever need them.

## When the internet drops

If something can't be loaded, the app says so (a red bar with **Reload**) instead of
showing empty lists. The marking screen shows no class at all unless everything for it
loaded, so a class can never look unmarked or empty by mistake. Saves that fail say
"could NOT be saved"; approving or rejecting a correction is saved in one step, so it
can't be left half-done.

## App Check

The settings in `public/firebase-config.js` are public (every web app's are), so anyone
could write a script that talks to the project directly. The database rules still decide
what they may see or change, but such a script could run up usage. **App Check** makes
Google answer only requests from this app's own pages. It is **off** until a site key is
filled in. Do the test project first, and use it for a few days before the real one.

1. Google reCAPTCHA admin (google.com/recaptcha/admin) → create a key: type
   **reCAPTCHA v3**, domains: the project's addresses (e.g.
   `attendance-system-demo-cbec9.web.app`, `attendance-system-demo-cbec9.firebaseapp.com`).
   You get a **site key** (public) and a **secret key** (private). (Google changes these
   pages from time to time; if it sends you elsewhere or asks for billing details, stop
   and check before going on.)
2. Firebase console → **App Check** → Apps → your web app → **reCAPTCHA** → paste the
   **secret key** there (only there; never in the code, never in a chat).
3. Put the **site key** in `public/firebase-config.js` → `APP_CHECK_SITE_KEYS.test`, then
   `firebase deploy -P test`.
4. Use the app normally for a few days, including from the college network. App Check →
   **APIs** shows how many requests are verified. Do not go on while any are unverified.
5. Only then: App Check → APIs → **Cloud Firestore** → **Enforce**, and the same for
   **Authentication**. (Undo: the same page → Unenforce.)

Good to know:

- After step 3 every user's browser must be able to reach Google's reCAPTCHA. If a
  network blocks Google, the app will not load there (checked in testing: it waits
  forever). That is why step 4 includes the college network.
- On `localhost` App Check is skipped, so the app can't be opened from your computer
  against an enforced project.
- Keep **Authentication → Settings → User actions → Enable create (sign-up)** ON: the app
  creates teacher and student logins from the HOD's browser.

## Students' attendance copies

Students may only see their own attendance. Each class's attendance is one document
for the whole class, so each student also gets a personal copy per subject
(collection `studentViews`), written automatically when attendance, leave or an
approved correction is saved. The HOD can recreate all copies from the original
records with **Admin Panel → Settings → Rebuild student copies**.

## Institution Dashboard

Each saved class also writes a small summary (`classSummaries`: who taught, present /
absent / leave as marked). The Principal's dashboard reads only these, so it stays quick
and cheap with many departments. Leave recorded after the class is included after the
HOD's next **Rebuild student copies**.
