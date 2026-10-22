# Department Attendance System

Attendance marking, registers and reports for a college department, with three roles:
**HOD**, **Teacher** and **Student**. Installable on phones and computers (PWA).

Built with plain HTML/CSS/JavaScript on **Firebase** (Authentication, Firestore, Hosting).
There is no build step and no server code.

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

## Deploying

```sh
firebase deploy            # hosting + Firestore rules
```

Note: `.firebaserc` (deploy target) and `public/firebase-config.js` (project the app
connects to) currently name **different** Firebase projects. Make them match before
relying on a deploy.
