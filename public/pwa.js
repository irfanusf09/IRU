// Installable app support: registers the service worker and shows an
// "Install App" button when the phone/computer offers installation.
(function () {
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(e => console.warn("Service worker not registered:", e));
    });
  }

  const isStandalone = () =>
    window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  let deferredPrompt = null;
  const buttons = () => document.querySelectorAll(".installAppBtn");
  const showButtons = show => buttons().forEach(b => { b.style.display = show ? "" : "none"; });

  window.addEventListener("beforeinstallprompt", e => {
    e.preventDefault();             // show our own button instead of the browser's banner
    deferredPrompt = e;
    showButtons(true);
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    showButtons(false);
  });

  document.addEventListener("DOMContentLoaded", () => {
    buttons().forEach(b => {
      b.onclick = async () => {
        if (!deferredPrompt) return;
        deferredPrompt.prompt();
        try { await deferredPrompt.userChoice; } catch (e) {}
        deferredPrompt = null;
        showButtons(false);
      };
    });
    // iPhone/iPad have no install button: show the Share-menu hint instead
    const hint = document.getElementById("iosInstallHint");
    if (hint && isIOS && !isStandalone()) hint.style.display = "block";
  });
})();

// Phone layout: "☰ Menu" button opens/closes the menu; choosing a screen closes it.
(function () {
  document.addEventListener("DOMContentLoaded", () => {
    const toggle = document.getElementById("menuToggle");
    const sidebar = document.getElementById("sidebar");
    if (!toggle || !sidebar) return;
    document.body.classList.add("mobile-ready");   // only now may the phone layout fold the menu away
    const isPhone = () => window.matchMedia("(max-width: 768px)").matches;
    const setOpen = open => {
      document.body.classList.toggle("menu-open", open);
      toggle.textContent = open ? "✕ Close" : "☰ Menu";
      toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      if (open) window.scrollTo(0, 0);
    };
    toggle.addEventListener("click", () => setOpen(!document.body.classList.contains("menu-open")));
    sidebar.addEventListener("click", e => {
      const btn = e.target.closest("button");
      if (!btn || !isPhone()) return;
      if (btn.classList.contains("installAppBtn")) return;
      setOpen(false);
      window.scrollTo(0, 0);
    });
  });
})();
