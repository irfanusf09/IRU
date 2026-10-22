// =====================================================================
// In-app dialogs — replace the browser's grey alert / confirm / prompt boxes.
//   await UI.alert("Saved.")                         → resolves when OK is pressed
//   if (await UI.confirm("Delete?", {danger: true}))  → true / false
//   const text = await UI.prompt("Reason:")           → text, or null if cancelled
//   const v = await UI.choose("Pick one", [{label, value}, …]) → value, or null
// Messages are shown as plain text (never as HTML), so names from Excel are safe.
// Only one dialog is shown at a time; others wait their turn.
// =====================================================================
const UI = (function () {
  const queue = [];
  let showing = false;
  let seq = 0;

  function build() {
    let overlay = document.getElementById("uiDialog");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "uiDialog";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.innerHTML = `
      <div class="ui-card">
        <div class="ui-title"></div>
        <div class="ui-msg"></div>
        <input class="ui-input" type="text" autocomplete="off">
        <div class="ui-choices"></div>
        <div class="ui-buttons">
          <button type="button" class="ui-cancel">Cancel</button>
          <button type="button" class="ui-ok primary">OK</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    return overlay;
  }

  function next() {
    if (showing || !queue.length) return;
    showing = true;
    const job = queue.shift();
    const o = build();
    const title = o.querySelector(".ui-title");
    const msg = o.querySelector(".ui-msg");
    const input = o.querySelector(".ui-input");
    const choices = o.querySelector(".ui-choices");
    const ok = o.querySelector(".ui-ok");
    const cancel = o.querySelector(".ui-cancel");
    const opts = job.opts || {};

    title.textContent = opts.title || "";
    title.style.display = opts.title ? "" : "none";
    msg.textContent = job.message == null ? "" : String(job.message);
    input.style.display = job.type === "prompt" ? "" : "none";
    input.value = opts.defaultValue || "";
    input.placeholder = opts.placeholder || "";
    choices.innerHTML = "";
    choices.style.display = job.type === "choose" ? "" : "none";
    cancel.style.display = job.type === "alert" ? "none" : "";
    cancel.textContent = opts.cancelText || "Cancel";
    ok.style.display = job.type === "choose" ? "none" : "";
    ok.textContent = opts.okText || "OK";
    ok.classList.toggle("ui-danger", !!opts.danger);

    let done = false;
    const prevFocus = document.activeElement;
    const finish = value => {
      if (done) return;
      done = true;
      o.classList.remove("open");
      o.removeAttribute("data-type");
      document.removeEventListener("keydown", onKey, true);
      showing = false;
      try { if (prevFocus && prevFocus.focus) prevFocus.focus(); } catch (e) {}
      job.resolve(value);
      setTimeout(next, 0);
    };
    const accept = () => finish(job.type === "prompt" ? input.value : job.type === "confirm" ? true : undefined);
    const reject = () => finish(job.type === "prompt" || job.type === "choose" ? null : job.type === "confirm" ? false : undefined);

    if (job.type === "choose") {
      (job.options || []).forEach((c, i) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "ui-choice";
        b.dataset.index = String(i + 1);
        b.textContent = c.label;
        b.onclick = () => finish(c.value);
        choices.appendChild(b);
      });
    }

    ok.onclick = accept;
    cancel.onclick = reject;
    o.onclick = e => { if (e.target === o && job.type !== "alert") reject(); };
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); job.type === "alert" ? accept() : reject(); }
      else if (e.key === "Enter" && job.type !== "choose") { e.preventDefault(); accept(); }
    }
    document.addEventListener("keydown", onKey, true);

    o.dataset.type = job.type;
    o.dataset.seq = String(++seq);
    o.classList.add("open");
    setTimeout(() => {
      try {
        if (job.type === "prompt") input.focus();
        else if (job.type === "choose") (choices.querySelector("button") || cancel).focus();
        else ok.focus();
      } catch (e) {}
    }, 30);
  }

  function open(type, message, opts, options) {
    return new Promise(resolve => {
      queue.push({ type, message, opts, options, resolve });
      if (document.body) next();
      else document.addEventListener("DOMContentLoaded", next, { once: true });
    });
  }

  return {
    alert: (message, opts) => open("alert", message, opts),
    confirm: (message, opts) => open("confirm", message, opts),
    prompt: (message, opts) => open("prompt", message, opts),
    choose: (message, options, opts) => open("choose", message, opts, options)
  };
})();

// ---------- Admin Panel tabs ----------
(function () {
  function show(tab) {
    const bar = document.getElementById("adminTabs");
    if (!bar) return;
    const valid = [...bar.querySelectorAll("button[data-tab]")].map(b => b.dataset.tab);
    if (!valid.includes(tab)) tab = valid[0];
    bar.querySelectorAll("button[data-tab]").forEach(b => {
      const on = b.dataset.tab === tab;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    document.querySelectorAll("#adminSection .admin-tab").forEach(p => p.classList.toggle("active", p.dataset.tab === tab));
    try { sessionStorage.setItem("adminTab", tab); } catch (e) {}
  }
  document.addEventListener("DOMContentLoaded", () => {
    const bar = document.getElementById("adminTabs");
    if (!bar) return;
    bar.addEventListener("click", e => {
      const b = e.target.closest("button[data-tab]");
      if (b) show(b.dataset.tab);
    });
    let last = null;
    try { last = sessionStorage.getItem("adminTab"); } catch (e) {}
    show(last || "batches");
  });
  UI.showAdminTab = show;
})();
