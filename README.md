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
| `tools/demo-seed/` | Fills an empty project with a sample institution, for demonstrations |
| `tools/reset-login/` | Project owner's tool: look up login IDs and give a forgotten login a new password |

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

## Testing the database rules

`tests/rules.test.mjs` checks `firestore.rules` against Google's Firestore emulator
(needs Node.js and Java):

```sh
cd tests
npm install
npm test
```

Run it after any change to `firestore.rules`, before deploying.

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
