// =====================================================================
// Internal assessment (awards)
//
// The subject's teacher holds as many assessments ("components") as they like:
// presentation, viva, MCQ, written…, each with its own maximum and minimum marks
// and exam date, plus optionally an attendance component filled from the
// attendance already recorded. At the end the teacher ticks which components
// count: the total is the sum of those, rounded up. Below a minimum is FAIL;
// not appearing is ABSENT (0 in the total); passing the total means PASS overall.
//
// Stored per subject in assessments/{subjectId}; each student gets their own copy
// (assessmentViews) showing which assessments they appeared in, and marks only
// for what the teacher has shared. Every entry or change is logged
// (assessmentLog). Only the teacher can change marks, only while the semester is
// ACTIVE (database rules); the HOD can view.
// =====================================================================
App.IA = {};
App.IA.DEFAULT_FULL_AT = 75;      // attendance % for full attendance marks (Institution Admin can change)

App.IA.round2 = n => Math.round(n * 100) / 100;
App.IA.roundUp = n => Math.ceil(n - 1e-9);
App.IA.empty = subjectId => ({ subjectId, components: [], marks: {}, final: { min: null, shared: false } });

App.IA.load = async function (subjectId) {
  const snap = await db.collection("assessments").doc(String(subjectId)).get();
  const d = snap.exists ? snap.data() : App.IA.empty(String(subjectId));
  d.components = d.components || []; d.marks = d.marks || {}; d.final = d.final || { min: null, shared: false };
  return d;
};

App.IA.fullMarksAt = async function () {
  const n = Number((await App.getSettings()).attendanceFullMarksAt);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : App.IA.DEFAULT_FULL_AT;
};

// ---------- results ----------
App.IA.markOf = (a, c, sid) => (a.marks[c.id] || {})[String(sid)];
App.IA.componentResult = function (c, m) {
  if (m === undefined || m === null) return "—";
  if (m === "AB") return "ABSENT";
  return m < Number(c.min || 0) ? "FAIL" : "PASS";
};
App.IA.counted = a => a.components.filter(c => c.counted !== false);
App.IA.finalOf = function (a, sid) {
  const comps = App.IA.counted(a);
  const max = comps.reduce((s, c) => s + Number(c.max), 0);
  let total = 0, appeared = 0, entered = 0;
  comps.forEach(c => {
    const m = App.IA.markOf(a, c, sid);
    if (m !== undefined && m !== null) entered++;
    if (typeof m === "number") { total += m; appeared++; }
  });
  const rounded = App.IA.roundUp(total);
  const min = a.final.min;
  let result = "—";
  if (comps.length && entered && !appeared) result = "ABSENT";
  else if (comps.length && appeared && min !== null && min !== undefined && min !== "") result = rounded >= Number(min) ? "PASS" : "FAIL";
  return { total: App.IA.round2(total), rounded, max, result, missing: comps.length - entered };
};

// ---------- saving: the record, every student's copy and the log, together ----------
App.IA.viewOf = function (a, st, subjectName, semester) {
  const sid = String(st.id);
  const fin = App.IA.finalOf(a, sid);
  return {
    studentId: sid, subjectId: a.subjectId, departmentId: a.departmentId, subjectName, semester: String(semester || ""),
    components: a.components.map(c => {
      const m = App.IA.markOf(a, c, sid);
      const v = { name: c.name, date: c.date || "", kind: c.kind || "exam",
                  status: m === undefined || m === null ? "pending" : m === "AB" ? "absent" : "appeared" };
      if (c.shared) Object.assign(v, { shared: true, max: Number(c.max), min: Number(c.min || 0),
                                       marks: typeof m === "number" ? m : null, result: App.IA.componentResult(c, m) });
      if (a.final.shared) v.counted = c.counted !== false;
      return v;
    }),
    final: a.final.shared ? { total: fin.rounded, max: fin.max, min: Number(a.final.min || 0), result: fin.result } : null,
    updatedAt: new Date().toISOString()
  };
};

App.IA.save = async function (ctx, next, logs) {
  const now = new Date().toISOString();
  next.departmentId = ctx.subject.departmentId;
  next.subjectId = String(ctx.subject.id);
  next.updatedAt = now;
  next.updatedBy = Auth.actorLabel();
  const batch = db.batch();
  batch.set(db.collection("assessments").doc(next.subjectId), {
    subjectId: next.subjectId, departmentId: next.departmentId, components: next.components, marks: next.marks,
    final: next.final, updatedAt: now, updatedBy: next.updatedBy });
  ctx.students.forEach(st => batch.set(db.collection("assessmentViews").doc(`${String(st.id)}_${next.subjectId}`),
    App.IA.viewOf(next, st, ctx.subject.name, ctx.subject.semester)));
  const by = Auth.actorLabel(), byUid = (firebase.auth().currentUser || {}).uid || "";
  logs.forEach(l => batch.set(db.collection("assessmentLog").doc(), {
    subjectId: next.subjectId, departmentId: next.departmentId, at: firebase.firestore.FieldValue.serverTimestamp(),
    by, byUid, action: l.action, componentId: l.componentId || "", componentName: l.componentName || "",
    changes: l.changes || [], note: l.note || "" }));
  await batch.commit();
};

// ---------- the screen (teacher edits; HOD views) ----------
App.IA.init = async function () {
  const select = document.getElementById("iaSubject");
  const body = document.getElementById("iaBody");
  if (!select || !body) return;
  body.innerHTML = "";
  const subjects = await App.fillSubjectSelect(select, { includeAll: false });
  if (!subjects.length) { body.innerHTML = "<p>No subjects.</p>"; return; }
  if (App.IA._subjectId && subjects.some(s => String(s.id) === App.IA._subjectId)) select.value = App.IA._subjectId;
  select.onchange = () => { App.IA._subjectId = select.value; App.IA._open = null; App.IA.render(); };
  App.IA._subjectId = select.value;
  await App.IA.render();
};

App.IA.render = async function () {
  const body = document.getElementById("iaBody");
  const subjectId = App.IA._subjectId;
  if (!subjectId) return;
  const my = (App.IA._seq = (App.IA._seq || 0) + 1);
  body.innerHTML = "<p>Loading…</p>";
  let ctx;
  try {
    const [subjects, batches, students, a, fullAt] = await Promise.all([
      App.getSubjects(), App.getBatches(), App.getStudentsIn(subjectId), App.IA.load(subjectId), App.IA.fullMarksAt()]);
    const subject = subjects.find(s => String(s.id) === String(subjectId));
    if (!subject) { body.innerHTML = "<p>Subject not found.</p>"; return; }
    const batch = batches.find(b => String(b.id) === String(subject.batchId) && String(b.semester) === String(subject.semester)) || {};
    const isTeacher = App.role() === "Teacher";
    ctx = { subject, batch, a, fullAt,
            students: students.filter(s => !s.status || s.status === "ACTIVE").sort(App.sortByRoll),
            canEdit: isTeacher && batch.status === "ACTIVE" };
    ctx.lockNote = !isTeacher ? "View only."
      : ctx.canEdit ? "" : "This semester is closed, so marks are locked. (If the HOD reopens the semester, they unlock.)";
  } catch (e) {
    console.warn(e);
    if (my === App.IA._seq) body.innerHTML = `<p style="color:#b91c1c;">${App.LOAD_FAILED}</p>`;
    return;
  }
  if (my !== App.IA._seq) return;
  App.IA._ctx = ctx;
  App.IA.draw(ctx);
};

App.IA.fmt = m => m === undefined || m === null ? "—" : m === "AB" ? "AB" : String(m);
App.IA.date = d => d ? d.split("-").reverse().join("-") : "";

App.IA.draw = function (ctx) {
  const { a, canEdit } = ctx;
  const body = document.getElementById("iaBody");
  const esc = App.esc;
  let html = ctx.lockNote ? `<p class="ia-note">${esc(ctx.lockNote)}</p>` : "";

  // Components
  html += `<h3>Assessments</h3>`;
  if (!a.components.length) html += `<p>No assessments yet.${canEdit ? " Add the first one below." : ""}</p>`;
  else {
    html += `<div style="overflow-x:auto;"><table class="ia-table"><tr><th>Assessment</th><th>Date</th><th>Max</th><th>Min</th>
      <th>Counts in total</th><th>Shared with students</th><th>Marks entered</th><th></th></tr>` +
      a.components.map(c => {
        const entered = Object.keys(a.marks[c.id] || {}).length;
        return `<tr><td style="text-align:left;">${esc(c.name)}${c.kind === "attendance" ? " <i>(attendance)</i>" : ""}</td>
          <td>${esc(App.IA.date(c.date))}</td><td>${esc(c.max)}</td><td>${esc(c.min || 0)}</td>
          <td><input type="checkbox" data-counted="${esc(c.id)}" ${c.counted !== false ? "checked" : ""} ${canEdit ? "" : "disabled"}></td>
          <td><input type="checkbox" data-shared="${esc(c.id)}" ${c.shared ? "checked" : ""} ${canEdit ? "" : "disabled"}></td>
          <td>${entered} / ${ctx.students.length}</td>
          <td><button data-marks="${esc(c.id)}">${canEdit ? "Enter marks" : "View marks"}</button>
              ${canEdit ? `<button data-edit="${esc(c.id)}">Edit</button>` : ""}
              ${canEdit && !entered ? `<button data-remove="${esc(c.id)}">Remove</button>` : ""}</td></tr>`;
      }).join("") + `</table></div>`;
  }
  if (canEdit) html += `<details class="ia-add" ${a.components.length ? "" : "open"}><summary>Add an assessment</summary>
      <label>Name <input id="iaName" placeholder="e.g. Viva, MCQ test, Presentation"></label>
      <label>Type <select id="iaKind"><option value="exam">Test / presentation / viva</option>
        <option value="attendance">Attendance (marks from attendance)</option></select></label>
      <label>Date <input type="date" id="iaDate"></label>
      <label>Max marks <input type="number" id="iaMax" min="0.5" step="0.5" style="width:90px;"></label>
      <label>Min marks <input type="number" id="iaMin" min="0" step="0.5" style="width:90px;" value="0"></label>
      <button id="iaAddBtn" class="primary">Add</button></details>`;

  // Marks for one component
  html += `<div id="iaMarks"></div>`;

  // Award
  const comps = App.IA.counted(a);
  html += `<h3 style="margin-top:24px;">Award</h3>`;
  if (!comps.length) html += `<p>Tick "Counts in total" for the assessments that make up the award.</p>`;
  else {
    const max = comps.reduce((s, c) => s + Number(c.max), 0);
    html += `<p>Total = ${comps.map(c => esc(c.name)).join(" + ")} = <b>${esc(max)}</b> marks (rounded up to whole marks).</p>
      <label>Minimum marks to pass the total:
        <input type="number" id="iaFinalMin" min="0" step="0.5" style="width:90px;" value="${a.final.min ?? ""}" ${canEdit ? "" : "disabled"}></label>
      <span id="iaFinalPct" style="color:#6b7280;"></span>
      <label style="margin-left:12px;"><input type="checkbox" id="iaFinalShared" ${a.final.shared ? "checked" : ""} ${canEdit ? "" : "disabled"}>
        Share the award with students</label>
      ${canEdit ? `<button id="iaFinalSave">Save</button>` : ""}
      <div style="overflow-x:auto;" id="iaAwardTable">${App.IA.awardTable(ctx)}</div>
      <button id="iaExcel">Download award (Excel)</button> <button id="iaPdf">Download award (PDF)</button>`;
  }
  html += `<p style="margin-top:18px;"><button id="iaLogBtn">Show change log</button></p><div id="iaLog"></div>`;
  body.innerHTML = html;
  App.IA.bind(ctx);
  if (App.IA._open) App.IA.openMarks(ctx, App.IA._open);
};

App.IA.awardTable = function (ctx, forPrint = false) {
  const { a } = ctx;
  const comps = App.IA.counted(a);
  const esc = App.esc;
  const head = comps.map(c => `<th>${esc(c.name)}<br><small>(${esc(c.max)})${c.date ? " " + esc(App.IA.date(c.date)) : ""}</small></th>`).join("");
  const max = comps.reduce((s, c) => s + Number(c.max), 0);
  let missing = 0;
  const rows = ctx.students.map(st => {
    const f = App.IA.finalOf(a, st.id);
    missing += f.missing;
    return `<tr><td>${esc(st.roll)}</td><td style="text-align:left;">${esc(st.name)}</td>` +
      comps.map(c => `<td>${esc(App.IA.fmt(App.IA.markOf(a, c, st.id)))}</td>`).join("") +
      `<td><b>${f.rounded}</b></td><td class="ia-${f.result.toLowerCase()}">${esc(f.result)}</td></tr>`;
  }).join("");
  return (missing && !forPrint ? `<p class="ia-note">${missing} mark(s) not entered yet (counted as 0).</p>` : "") +
    `<table class="ia-table" border="1" cellpadding="4" style="border-collapse:collapse;"><tr><th>Roll No.</th><th>Name</th>${head}
     <th>Total (${esc(max)})</th><th>Result</th></tr>${rows}</table>`;
};

App.IA.bind = function (ctx) {
  const { a } = ctx;
  const q = s => document.getElementById(s);
  const body = q("iaBody");
  const comp = id => a.components.find(c => c.id === id);
  const clone = () => JSON.parse(JSON.stringify(a));
  const run = async (next, logs, done) => {
    try {
      await App.IA.save(ctx, next, logs);
      if (done) await UI.alert(done);
    } catch (e) {
      console.error(e);
      await UI.alert("Could NOT be saved. Check the internet connection and try again.");
    }
    await App.IA.render();
  };

  body.querySelectorAll("[data-marks]").forEach(b => b.onclick = () => { App.IA._open = b.dataset.marks; App.IA.openMarks(ctx, b.dataset.marks); });
  body.querySelectorAll("[data-counted]").forEach(cb => cb.onchange = () => {
    const next = clone(), c = next.components.find(x => x.id === cb.dataset.counted);
    c.counted = cb.checked;
    run(next, [{ action: cb.checked ? "counted" : "not counted", componentId: c.id, componentName: c.name }]);
  });
  body.querySelectorAll("[data-shared]").forEach(cb => cb.onchange = () => {
    const next = clone(), c = next.components.find(x => x.id === cb.dataset.shared);
    c.shared = cb.checked;
    run(next, [{ action: cb.checked ? "shared" : "unshared", componentId: c.id, componentName: c.name }]);
  });
  body.querySelectorAll("[data-remove]").forEach(b => b.onclick = async () => {
    const c = comp(b.dataset.remove);
    if (!(await UI.confirm(`Remove "${c.name}"? (No marks have been entered for it.)`, { okText: "Remove", danger: true }))) return;
    const next = clone();
    next.components = next.components.filter(x => x.id !== c.id);
    delete next.marks[c.id];
    run(next, [{ action: "removed", componentId: c.id, componentName: c.name }]);
  });
  body.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => App.IA.edit(ctx, comp(b.dataset.edit), run, clone));

  const addBtn = q("iaAddBtn");
  if (addBtn) addBtn.onclick = () => {
    const name = q("iaName").value.trim(), max = Number(q("iaMax").value), min = Number(q("iaMin").value || 0);
    const kind = q("iaKind").value, date = q("iaDate").value;
    if (!name) { UI.alert("Enter a name for the assessment."); return; }
    if (!(max > 0)) { UI.alert("Enter the maximum marks."); return; }
    if (!(min >= 0 && min <= max)) { UI.alert("Minimum marks must be between 0 and the maximum."); return; }
    if (a.components.some(c => c.name.toLowerCase() === name.toLowerCase())) { UI.alert(`There is already an assessment called "${name}".`); return; }
    const next = clone();
    const c = { id: "c" + Date.now().toString(36), name, kind, date, max, min, counted: true, shared: false };
    next.components.push(c);
    run(next, [{ action: "added", componentId: c.id, componentName: name, note: `max ${max}, min ${min}${date ? ", " + date : ""}${kind === "attendance" ? ", attendance" : ""}` }]);
  };

  const minIn = q("iaFinalMin"), pct = q("iaFinalPct");
  const showPct = () => {
    const max = App.IA.counted(a).reduce((s, c) => s + Number(c.max), 0);
    if (pct) pct.textContent = minIn && minIn.value !== "" && max ? `(${App.IA.round2(Number(minIn.value) / max * 100)}%)` : "";
  };
  if (minIn) { minIn.oninput = showPct; showPct(); }
  const finalSave = q("iaFinalSave");
  if (finalSave) finalSave.onclick = () => {
    const max = App.IA.counted(a).reduce((s, c) => s + Number(c.max), 0);
    const min = minIn.value === "" ? null : Number(minIn.value);
    if (min !== null && !(min >= 0 && min <= max)) { UI.alert(`Minimum marks must be between 0 and ${max}.`); return; }
    const shared = q("iaFinalShared").checked;
    const next = clone();
    next.final = { min, shared };
    const notes = [];
    if (min !== a.final.min) notes.push(`minimum ${a.final.min ?? "—"} → ${min ?? "—"}`);
    if (shared !== !!a.final.shared) notes.push(shared ? "award shared with students" : "award no longer shared");
    if (!notes.length) { UI.alert("Nothing changed."); return; }
    run(next, [{ action: "award", note: notes.join("; ") }], "Saved.");
  };

  const excel = q("iaExcel"), pdf = q("iaPdf");
  if (excel) excel.onclick = () => App.IA.exportExcel(ctx);
  if (pdf) pdf.onclick = () => App.IA.exportPdf(ctx);
  q("iaLogBtn").onclick = () => App.IA.showLog(ctx);
};

// Change a component's name, date, max or min. A new max rescales everyone's marks.
App.IA.edit = async function (ctx, c, run, clone) {
  const name = await UI.prompt("Name:", { defaultValue: c.name, title: `Edit "${c.name}"` });
  if (name === null) return;
  const date = await UI.prompt("Date (YYYY-MM-DD, or empty):", { defaultValue: c.date || "", title: `Edit "${c.name}"` });
  if (date === null) return;
  const maxS = await UI.prompt("Maximum marks (a new maximum rescales the marks already entered):", { defaultValue: String(c.max), title: `Edit "${c.name}"` });
  if (maxS === null) return;
  const minS = await UI.prompt("Minimum marks:", { defaultValue: String(c.min || 0), title: `Edit "${c.name}"` });
  if (minS === null) return;
  const max = Number(maxS), min = Number(minS);
  if (!name.trim()) { UI.alert("The name can't be empty."); return; }
  if (date.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) { UI.alert("Date must look like 2026-10-24."); return; }
  if (!(max > 0) || !(min >= 0 && min <= max)) { UI.alert("Max must be above 0, and min between 0 and max."); return; }
  const next = clone(), n = next.components.find(x => x.id === c.id);
  const notes = [];
  if (name.trim() !== c.name) notes.push(`name "${c.name}" → "${name.trim()}"`);
  if (date.trim() !== (c.date || "")) notes.push(`date ${c.date || "—"} → ${date.trim() || "—"}`);
  if (min !== Number(c.min || 0)) notes.push(`min ${c.min || 0} → ${min}`);
  const changes = [];
  if (max !== Number(c.max)) {
    notes.push(`max ${c.max} → ${max}; marks rescaled`);
    const marks = next.marks[c.id] || {};
    Object.keys(marks).forEach(sid => {
      if (typeof marks[sid] !== "number") return;
      const to = App.IA.round2(marks[sid] * max / Number(c.max));
      if (to !== marks[sid]) changes.push({ studentId: sid, from: marks[sid], to });
      marks[sid] = to;
    });
  }
  if (!notes.length) { UI.alert("Nothing changed."); return; }
  if (max !== Number(c.max) && changes.length &&
      !(await UI.confirm(`Change the maximum from ${c.max} to ${max}?\n\nAll ${changes.length} marks already entered will be rescaled (e.g. ${changes[0].from} → ${changes[0].to}).`, { okText: "Change" }))) return;
  Object.assign(n, { name: name.trim(), date: date.trim(), max, min });
  run(next, [{ action: "edited", componentId: c.id, componentName: n.name, changes, note: notes.join("; ") }], "Saved.");
};

// Marks for one component: one row per student; "AB" for not appearing
App.IA.openMarks = async function (ctx, compId) {
  const { a, canEdit } = ctx;
  const c = a.components.find(x => x.id === compId);
  const box = document.getElementById("iaMarks");
  if (!c || !box) return;
  const esc = App.esc;
  const marks = a.marks[c.id] || {};
  let att = {};
  if (c.kind === "attendance") {
    const data = await App.loadSubjectData(String(ctx.subject.id));
    ctx.students.forEach(st => { att[String(st.id)] = data.tally(st.id); });
  }
  box.innerHTML = `<h3 style="margin-top:20px;">${esc(c.name)} — marks out of ${esc(c.max)} (minimum ${esc(c.min || 0)})</h3>
    ${c.kind === "attendance" ? `<p class="ia-note">Attendance marks: ${esc(ctx.fullAt)}% attendance or more gets full marks; below that,
      marks in proportion to attendance (e.g. 50% → half the marks). Leave days are not counted.
      ${canEdit ? `<button id="iaFillAtt">Fill from attendance</button>` : ""}</p>` : ""}
    <div style="overflow-x:auto;"><table class="ia-table"><tr><th>Roll No.</th><th>Name</th>${c.kind === "attendance" ? "<th>Attendance</th>" : ""}
      <th>Marks</th><th>Absent</th><th>Result</th></tr>` +
    ctx.students.map(st => {
      const sid = String(st.id), m = marks[sid];
      const t = att[sid];
      return `<tr><td>${esc(st.roll)}</td><td style="text-align:left;">${esc(st.name)}</td>
        ${c.kind === "attendance" ? `<td>${t && t.total ? `${t.present}/${t.total} (${App.IA.round2(t.present / t.total * 100)}%)` : "—"}</td>` : ""}
        <td><input type="number" class="ia-mark" data-sid="${esc(sid)}" min="0" max="${esc(c.max)}" step="0.01" style="width:80px;"
             value="${typeof m === "number" ? m : ""}" ${canEdit && m !== "AB" ? "" : "disabled"}></td>
        <td><input type="checkbox" class="ia-ab" data-sid="${esc(sid)}" ${m === "AB" ? "checked" : ""} ${canEdit ? "" : "disabled"}></td>
        <td>${esc(App.IA.componentResult(c, m))}</td></tr>`;
    }).join("") + `</table></div>
    ${canEdit ? `<button id="iaSaveMarks" class="primary">Save marks</button>` : ""} <button id="iaCloseMarks">Close</button>`;
  box.scrollIntoView({ behavior: "smooth", block: "start" });

  box.querySelectorAll(".ia-ab").forEach(cb => cb.onchange = () => {
    const input = box.querySelector(`.ia-mark[data-sid="${cb.dataset.sid}"]`);
    input.disabled = cb.checked;
    if (cb.checked) input.value = "";
  });
  document.getElementById("iaCloseMarks").onclick = () => { App.IA._open = null; box.innerHTML = ""; };
  const fill = document.getElementById("iaFillAtt");
  if (fill) fill.onclick = () => {
    let filled = 0;
    ctx.students.forEach(st => {
      const t = att[String(st.id)], input = box.querySelector(`.ia-mark[data-sid="${String(st.id)}"]`);
      const ab = box.querySelector(`.ia-ab[data-sid="${String(st.id)}"]`);
      if (!t || !t.total || ab.checked) return;
      const pct = t.present / t.total * 100;
      input.value = pct >= ctx.fullAt ? c.max : App.IA.round2(Number(c.max) * pct / 100);
      filled++;
    });
    UI.alert(`Filled for ${filled} student(s). Check, then press "Save marks".`);
  };
  const save = document.getElementById("iaSaveMarks");
  if (save) save.onclick = async () => {
    const next = JSON.parse(JSON.stringify(a));
    const now = next.marks[c.id] = { ...(next.marks[c.id] || {}) };
    const changes = [];
    for (const st of ctx.students) {
      const sid = String(st.id);
      const ab = box.querySelector(`.ia-ab[data-sid="${sid}"]`).checked;
      const raw = box.querySelector(`.ia-mark[data-sid="${sid}"]`).value.trim();
      let to;
      if (ab) to = "AB";
      else if (raw === "") to = undefined;
      else {
        to = App.IA.round2(Number(raw));
        if (!Number.isFinite(to) || to < 0 || to > Number(c.max)) {
          await UI.alert(`${st.name} (${st.roll}): marks must be between 0 and ${c.max}.`);
          return;
        }
      }
      const from = now[sid];
      if (from === to) continue;
      changes.push({ studentId: sid, roll: String(st.roll || ""), from: from === undefined ? null : from, to: to === undefined ? null : to });
      if (to === undefined) delete now[sid]; else now[sid] = to;
    }
    if (!changes.length) { await UI.alert("Nothing changed."); return; }
    try {
      await App.IA.save(ctx, next, [{ action: "marks", componentId: c.id, componentName: c.name, changes }]);
      await UI.alert(`Saved ${changes.length} change(s).`);
    } catch (e) {
      console.error(e);
      await UI.alert("Marks could NOT be saved. Check the internet connection and try again.");
    }
    await App.IA.render();
  };
};

App.IA.showLog = async function (ctx) {
  const out = document.getElementById("iaLog");
  out.innerHTML = "<p>Loading…</p>";
  try {
    let q = db.collection("assessmentLog").where("subjectId", "==", String(ctx.subject.id));
    if (App.role() === "HOD") q = q.where("departmentId", "==", App.dept());
    const entries = (await App._docs(q)).sort((x, y) => (y.at ? y.at.toMillis() : 0) - (x.at ? x.at.toMillis() : 0));
    const who = Object.fromEntries(ctx.students.map(s => [String(s.id), `${s.roll} ${s.name}`]));
    const esc = App.esc;
    out.innerHTML = !entries.length ? "<p>No changes yet.</p>" :
      `<div style="overflow-x:auto;"><table class="ia-table"><tr><th>When</th><th>By</th><th>What</th><th>Details</th></tr>` +
      entries.map(e => `<tr><td>${e.at ? esc(e.at.toDate().toLocaleString()) : ""}</td><td>${esc(e.by)}</td>
        <td>${esc(e.action)}${e.componentName ? " — " + esc(e.componentName) : ""}</td>
        <td style="text-align:left;">${esc(e.note || "")}${(e.changes || []).map(ch =>
          `<div>${esc(who[ch.studentId] || ch.roll || ch.studentId)}: ${esc(App.IA.fmt(ch.from))} → ${esc(App.IA.fmt(ch.to))}</div>`).join("")}</td></tr>`).join("") +
      `</table></div>`;
  } catch (e) {
    console.warn(e);
    out.innerHTML = `<p style="color:#b91c1c;">${App.LOAD_FAILED}</p>`;
  }
};

// ---------- award list: Excel and PDF ----------
App.IA.heading = async function (ctx) {
  const [inst, dept, teachers, map] = await Promise.all([App.institutionName(), App.departmentName(ctx.subject.departmentId),
    App.getTeachersFromFirestore(), App.getSubjectAssignmentsFromFirestore()]);
  const t = teachers.find(x => String(x.id) === String(map[String(ctx.subject.id)]));
  const b = ctx.batch;
  return { inst, dept, teacher: t ? t.name : "",
           title: `${ctx.subject.name} [${ctx.subject.type || ""}]`,
           sem: `${b.program || ctx.subject.program || ""} Semester ${ctx.subject.semester} (Batch ${b.year || ctx.subject.year || ""})` };
};
App.IA.fileName = ctx => `Award_${ctx.subject.name}_Sem${ctx.subject.semester}`.replace(/[^A-Za-z0-9_-]+/g, "_");

App.IA.exportExcel = async function (ctx) {
  if (!(await App.lib("xlsx"))) return;
  const h = await App.IA.heading(ctx);
  const comps = App.IA.counted(ctx.a);
  const max = comps.reduce((s, c) => s + Number(c.max), 0);
  const rows = [[h.inst], [`Department of ${h.dept}`], ["Internal Assessment — Award List"], [`Subject: ${h.title}`], [h.sem],
    [`Teacher: ${h.teacher}`], [],
    ["Roll No.", "Name", ...comps.map(c => `${c.name} (${c.max})${c.date ? " " + App.IA.date(c.date) : ""}`), `Total (${max})`, "Result"],
    ...ctx.students.map(st => {
      const f = App.IA.finalOf(ctx.a, st.id);
      return [st.roll, st.name, ...comps.map(c => App.IA.fmt(App.IA.markOf(ctx.a, c, st.id))), f.rounded, f.result];
    }),
    [], [`Minimum to pass the total: ${ctx.a.final.min ?? "not set"}`], ["AB = absent (counted as 0). Totals are rounded up."]];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Award");
  XLSX.writeFile(wb, App.IA.fileName(ctx) + ".xlsx");
};

App.IA.exportPdf = async function (ctx) {
  if (!(await App.lib("pdf"))) return;
  const h = await App.IA.heading(ctx);
  const esc = App.esc;
  const html = `<div style="font-family:Arial,sans-serif; font-size:12px; padding:10px;">
    <h2 style="text-align:center; margin:0;">${esc(h.inst)}</h2>
    <h3 style="text-align:center; margin:4px 0;">Department of ${esc(h.dept)}</h3>
    <h3 style="text-align:center; margin:4px 0 12px;">Internal Assessment — Award List</h3>
    <p><b>Subject:</b> ${esc(h.title)}<br><b>${esc(h.sem)}</b><br><b>Teacher:</b> ${esc(h.teacher)}</p>
    ${App.IA.awardTable(ctx, true)}
    <p>Minimum to pass the total: ${esc(ctx.a.final.min ?? "not set")}. AB = absent (counted as 0). Totals are rounded up.</p>
    <div style="margin-top:50px; display:flex; justify-content:space-between;">
      <div>__________________<br>Teacher</div><div>__________________<br>Head of Department</div></div></div>`;
  html2pdf().set({ filename: App.IA.fileName(ctx) + ".pdf", margin: 10, jsPDF: { format: "a4", orientation: "portrait" } })
    .from(html).save();
};

// ---------- student: their own assessments ----------
App.IA.renderStudent = async function () {
  const out = document.getElementById("studentAssessmentOutput");
  const user = Auth.currentUser();
  if (!out || !user || user.role !== "Student") return;
  out.innerHTML = "<p>Loading…</p>";
  try {
    const views = await App._docs(db.collection("assessmentViews").where("studentId", "==", String(user.studentDocId)));
    const esc = App.esc;
    if (!views.length) { out.innerHTML = "<p>No internal assessments yet.</p>"; return; }
    out.innerHTML = views.sort((x, y) => String(x.subjectName).localeCompare(String(y.subjectName))).map(v => {
      const rows = (v.components || []).map(c => `<tr><td style="text-align:left;">${esc(c.name)}${v.final && c.counted === false ? " <i>(not counted)</i>" : ""}</td>
        <td>${esc(App.IA.date(c.date))}</td>
        <td>${c.status === "appeared" ? "Appeared" : c.status === "absent" ? "<b>Absent</b>" : "Not yet entered"}</td>
        <td>${c.shared ? (c.marks === null ? "—" : `${esc(c.marks)} / ${esc(c.max)}`) : "<i>not shared yet</i>"}</td>
        <td>${c.shared ? esc(c.result) : ""}</td></tr>`).join("");
      return `<div class="ia-card"><h4>${esc(v.subjectName)}</h4>
        <div style="overflow-x:auto;"><table class="ia-table"><tr><th>Assessment</th><th>Date</th><th>You</th><th>Marks</th><th>Result</th></tr>${rows}</table></div>
        ${v.final ? `<p><b>Award: ${esc(v.final.total)} / ${esc(v.final.max)} — ${esc(v.final.result)}</b></p>` : "<p><i>Award not shared yet.</i></p>"}</div>`;
    }).join("");
  } catch (e) {
    console.warn(e);
    out.innerHTML = `<p style="color:#b91c1c;">${App.LOAD_FAILED}</p>`;
  }
};
