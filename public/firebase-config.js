// =====================================================================
// Firebase project settings (copied from Firebase console → Project
// settings → Your apps → Config).
//
// The app picks the project from the address it is opened at:
//   - the test project's own addresses, or this computer (localhost) → TEST
//   - everything else (attendance-system-df860, custom domains)       → REAL
// So the same files can be deployed to either project unchanged.
// =====================================================================
const FIREBASE_PROJECTS = {
  real: {
    apiKey: "AIzaSyAiWAwyHqLI-3tq-OlFj3IXWvWpVBdZarQ",
    authDomain: "attendance-system-df860.firebaseapp.com",
    projectId: "attendance-system-df860",
    storageBucket: "attendance-system-df860.firebasestorage.app",
    messagingSenderId: "634956189552",
    appId: "1:634956189552:web:e35dbbb4e7f3e29a9689b5"
  },
  test: {
    apiKey: "AIzaSyBUAF-uT7AVRP590nsy5uhiRI0ZTfz8dd8",
    authDomain: "attendance-system-demo-cbec9.firebaseapp.com",
    projectId: "attendance-system-demo-cbec9",
    storageBucket: "attendance-system-demo-cbec9.firebasestorage.app",
    messagingSenderId: "477812981496",
    appId: "1:477812981496:web:fd8d4f3992a38caaa9850d"
  }
};

const TEST_HOSTS = [
  "attendance-system-demo-cbec9.web.app",
  "attendance-system-demo-cbec9.firebaseapp.com",
  "localhost",
  "127.0.0.1"
];

const firebaseConfig = TEST_HOSTS.includes(location.hostname)
  ? FIREBASE_PROJECTS.test
  : FIREBASE_PROJECTS.real;

// App Check (reCAPTCHA v3) site key for each project. Empty = App Check off.
// The site key is public; the matching SECRET key goes only into the Firebase
// console (App Check -> register the web app), never into this file.
// See README -> "App Check".
const APP_CHECK_SITE_KEYS = {
  real: "",
  test: ""
};
const appCheckSiteKey = TEST_HOSTS.includes(location.hostname)
  ? APP_CHECK_SITE_KEYS.test
  : APP_CHECK_SITE_KEYS.real;
