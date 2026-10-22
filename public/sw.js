// Service worker for the installable app.
// It deliberately does NOT store copies of the app: every page load comes fresh
// from the server, so a new "firebase deploy" reaches everyone immediately.
// Its only job is a friendly message when the phone has no internet.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

const OFFLINE_PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Offline</title>
<style>body{font-family:system-ui,Arial,sans-serif;background:#f1f5f9;color:#111827;display:flex;
align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px;text-align:center}
.c{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:24px;max-width:340px}
button{margin-top:12px;padding:9px 16px;border-radius:6px;border:1px solid #1f4fd8;background:#1f4fd8;color:#fff;font-size:15px}
</style></head><body><div class="c"><h2>No internet connection</h2>
<p>The attendance app needs the internet to load. Check your connection and try again.</p>
<button onclick="location.reload()">Try again</button></div></body></html>`;

self.addEventListener("fetch", event => {
  // Only page loads are handled; everything else goes straight to the network.
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(() =>
      new Response(OFFLINE_PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } })
    )
  );
});
