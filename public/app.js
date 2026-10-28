const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const $ = (id) => document.getElementById(id);

// Last state confirmed by the server. UI updates only from server responses.
const state = { settings: null, watches: [], slots: [], status: null, catalog: null };
let editingId = null; // null = closed, 0 = new watch, otherwise watch id

class Unauthorized extends Error {}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== "/api/login") throw new Unauthorized();
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showLogin() {
  $("app-view").hidden = true;
  $("login-view").hidden = false;
}

/** Runs a request with its button disabled. Returns undefined on failure after showing the error. */
async function withPending(button, errorEl, fn) {
  button.disabled = true;
  errorEl.textContent = "";
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Unauthorized) showLogin();
    else errorEl.textContent = e.message;
  } finally {
    button.disabled = false;
  }
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Slot times are Los Angeles wall-clock values. Formatting them as UTC keeps the wall-clock value unchanged.
const slotFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
});
const fmtInstant = (iso) => (iso ? new Date(iso).toLocaleString() : "never");

// ---------- rendering ----------

function render() {
  renderStatus();
  renderSlots();
  renderWatches();
  renderSettings();
}

function renderStatus() {
  const s = state.status;
  const rows = [
    ["State", s.running ? "Checking now…" : state.settings.paused ? "Paused" : "Idle"],
    ["Last check started", fmtInstant(s.lastStartedAt)],
    ["Last check finished", fmtInstant(s.lastFinishedAt)],
    ["Next automatic check", state.settings.paused ? "paused" : fmtInstant(s.nextRunAt)],
  ].map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`);
  if (s.lastError) rows.push(`<dt>Last error</dt><dd class="error">${esc(s.lastError)}</dd>`);
  $("status").innerHTML = rows.join("");
  $("pause-btn").textContent = state.settings.paused ? "Resume" : "Pause";
}

function renderSlots() {
  if (state.slots.length === 0) {
    $("slots").innerHTML = `<p class="muted">No open slots match your watches.</p>`;
    return;
  }
  const labels = Object.fromEntries(state.watches.map((w) => [w.id, w.label]));
  $("slots").innerHTML = `<table><thead><tr><th>Watch</th><th>Date &amp; time</th><th>Available</th><th>First seen</th><th>Emailed</th></tr></thead><tbody>${state.slots
    .map(
      (s) => `<tr>
        <td>${esc(labels[s.watchId] ?? `#${s.watchId}`)}</td>
        <td>${esc(slotFormat.format(new Date(`${s.startsAt}:00Z`)))}</td>
        <td>${s.available}</td>
        <td>${esc(fmtInstant(s.firstSeenAt))}</td>
        <td>${s.notifiedAt ? esc(fmtInstant(s.notifiedAt)) : `<span class="badge warn">pending</span>`}</td>
      </tr>`,
    )
    .join("")}</tbody></table>`;
}

function describeRange(w) {
  const range =
    w.rangeMode === "ABSOLUTE" ? `${w.dateFrom} to ${w.dateTo}` : `${w.minDaysOut}–${w.maxDaysOut} days out`;
  const filters = [];
  if (w.weekdays.length) filters.push(w.weekdays.map((d) => WEEKDAYS[d]).join(", "));
  if (w.timeFrom || w.timeTo) filters.push(`${w.timeFrom || "any"}–${w.timeTo || "any"}`);
  return filters.length ? `${range}<br><span class="muted">${esc(filters.join(" · "))}</span>` : range;
}

function renderWatches() {
  if (state.watches.length === 0) {
    $("watches").innerHTML = `<p class="muted">No watches yet. Add one to start monitoring.</p>`;
    return;
  }
  const errors = state.status.watchErrors;
  $("watches").innerHTML = `<table><thead><tr><th>Label</th><th>Location</th><th>Type</th><th>Range</th><th>Open</th><th>State</th><th></th></tr></thead><tbody>${state.watches
    .map((w) => {
      const open = state.slots.filter((s) => s.watchId === w.id).length;
      const badge = errors[w.id]
        ? `<span class="badge warn" title="${esc(errors[w.id])}">error</span><br><span class="error">${esc(errors[w.id])}</span>`
        : `<span class="badge ${w.active ? "on" : ""}">${w.active ? "active" : "paused"}</span>`;
      return `<tr>
        <td>${esc(w.label)}</td>
        <td>${esc(w.courthouseName)}<br><span class="muted">${esc(w.departmentName)}</span></td>
        <td>${esc(w.reservationTypeName)}</td>
        <td>${describeRange(w)}</td>
        <td>${open}</td>
        <td>${badge}</td>
        <td><div class="actions">
          <button class="small secondary" data-action="edit" data-id="${w.id}">Edit</button>
          <button class="small secondary" data-action="toggle" data-id="${w.id}">${w.active ? "Pause" : "Resume"}</button>
          <button class="small danger" data-action="delete" data-id="${w.id}">Delete</button>
        </div></td>
      </tr>`;
    })
    .join("")}</tbody></table>`;
}

function renderSettings() {
  const f = $("settings-form");
  f.pollIntervalMinutes.value = state.settings.pollIntervalMinutes;
  f.probeCaseNumber.value = state.settings.probeCaseNumber;
  f.recipients.value = state.settings.recipients.join("\n");
}

// ---------- data loading ----------

async function loadState() {
  Object.assign(state, await api("GET", "/api/state"));
  $("login-view").hidden = true;
  $("app-view").hidden = false;
  render();
}

async function ensureCatalog() {
  state.catalog ??= await api("GET", "/api/catalog");
  return state.catalog;
}

function fillSelect(select, options, selected, placeholder) {
  select.innerHTML =
    `<option value="">${esc(placeholder)}</option>` +
    options.map((o) => `<option value="${esc(o.code)}">${esc(o.name)}</option>`).join("");
  select.value = selected ?? "";
}

/** Fills the department dropdown (edit mode) or the department checklist (new mode) for a courthouse. */
async function loadDepartments(courthouseCode, selected) {
  const select = $("watch-form").departmentCode;
  const boxes = $("dept-boxes");
  $("dept-select-all").checked = false;
  if (!courthouseCode) {
    fillSelect(select, [], "", "Choose a courthouse first");
    boxes.innerHTML = `<p class="muted">Choose a courthouse first.</p>`;
    return;
  }
  select.disabled = true;
  fillSelect(select, [], "", "Loading departments…");
  boxes.innerHTML = `<p class="muted">Loading departments…</p>`;
  try {
    const departments = await api("GET", `/api/catalog/departments/${encodeURIComponent(courthouseCode)}`);
    fillSelect(select, departments, selected, "Choose a department");
    boxes.innerHTML = departments
      .map(
        (d) =>
          `<label class="inline"><input type="checkbox" name="department" value="${esc(d.code)}" data-name="${esc(d.name)}" /> ${esc(d.name)}</label>`,
      )
      .join("");
  } finally {
    select.disabled = false;
  }
}

// ---------- watch editor ----------

function syncRangeVisibility() {
  const mode = $("watch-form").querySelector("input[name=rangeMode]:checked")?.value;
  for (const el of document.querySelectorAll("[data-range]")) el.hidden = el.dataset.range !== mode;
}

async function openWatchForm(watch) {
  const form = $("watch-form");
  const errorEl = $("watch-form-error");
  editingId = watch ? watch.id : 0;
  $("watch-form-title").textContent = watch ? `Edit “${watch.label}”` : "New watches";
  for (const el of form.querySelectorAll("[data-mode]")) el.hidden = el.dataset.mode !== (watch ? "edit" : "new");
  form.departmentCode.required = Boolean(watch);
  form.hidden = false;
  errorEl.textContent = "";
  $("watch-save-btn").disabled = true;
  form.reset();

  const w = watch ?? {
    label: "", active: true, courthouseCode: "", departmentCode: "", reservationTypeCode: "",
    rangeMode: "RELATIVE", dateFrom: "", dateTo: "", minDaysOut: 16, maxDaysOut: 60, weekdays: [], timeFrom: "", timeTo: "",
  };
  form.label.value = w.label;
  form.active.checked = w.active;
  form.querySelector(`input[name=rangeMode][value=${w.rangeMode}]`).checked = true;
  form.dateFrom.value = w.dateFrom ?? "";
  form.dateTo.value = w.dateTo ?? "";
  form.minDaysOut.value = w.minDaysOut ?? "";
  form.maxDaysOut.value = w.maxDaysOut ?? "";
  form.timeFrom.value = w.timeFrom ?? "";
  form.timeTo.value = w.timeTo ?? "";
  for (const box of form.querySelectorAll("input[name=weekday]")) box.checked = w.weekdays.includes(Number(box.value));
  syncRangeVisibility();

  try {
    form.courthouseCode.disabled = form.reservationTypeCode.disabled = true;
    fillSelect(form.courthouseCode, [], "", "Loading courthouses…");
    fillSelect(form.reservationTypeCode, [], "", "Loading reservation types…");
    const catalog = await ensureCatalog();
    fillSelect(form.courthouseCode, catalog.courthouses, w.courthouseCode, "Choose a courthouse");
    fillSelect(form.reservationTypeCode, catalog.reservationTypes, w.reservationTypeCode, "Choose a reservation type");
    await loadDepartments(w.courthouseCode, w.departmentCode);
    $("watch-save-btn").disabled = false;
  } catch (e) {
    if (e instanceof Unauthorized) showLogin();
    else errorEl.textContent = `Could not load portal options: ${e.message}`;
  } finally {
    form.courthouseCode.disabled = form.reservationTypeCode.disabled = false;
  }
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

function closeWatchForm() {
  editingId = null;
  $("watch-form").hidden = true;
}

const selectedText = (select) => select.options[select.selectedIndex]?.text ?? "";
const numberOrNull = (input) => (input.value === "" ? null : Number(input.value));

function watchPayload(form) {
  const department =
    editingId === 0
      ? {
          departments: [...form.querySelectorAll("input[name=department]:checked")].map((b) => ({
            code: b.value,
            name: b.dataset.name,
          })),
        }
      : { departmentCode: form.departmentCode.value, departmentName: selectedText(form.departmentCode) };
  return {
    label: form.label.value,
    active: form.active.checked,
    courthouseCode: form.courthouseCode.value,
    courthouseName: selectedText(form.courthouseCode),
    ...department,
    reservationTypeCode: form.reservationTypeCode.value,
    reservationTypeName: selectedText(form.reservationTypeCode),
    rangeMode: form.querySelector("input[name=rangeMode]:checked").value,
    dateFrom: form.dateFrom.value || null,
    dateTo: form.dateTo.value || null,
    minDaysOut: numberOrNull(form.minDaysOut),
    maxDaysOut: numberOrNull(form.maxDaysOut),
    weekdays: [...form.querySelectorAll("input[name=weekday]:checked")].map((b) => Number(b.value)),
    timeFrom: form.timeFrom.value || null,
    timeTo: form.timeTo.value || null,
  };
}

/** Applies a confirmed watch and its open slots from an update response. */
function applyWatchUpdate(watch, slots) {
  state.watches = state.watches.map((w) => (w.id === watch.id ? watch : w));
  state.slots = [...state.slots.filter((s) => s.watchId !== watch.id), ...slots].sort(
    (a, b) => a.watchId - b.watchId || a.startsAt.localeCompare(b.startsAt),
  );
}

// ---------- event wiring ----------

$("weekday-boxes").innerHTML = WEEKDAYS.map(
  (d, i) => `<label class="inline"><input type="checkbox" name="weekday" value="${i}" /> ${d}</label>`,
).join("");

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const button = e.target.querySelector("button");
  await withPending(button, $("login-error"), async () => {
    await api("POST", "/api/login", { password: e.target.password.value });
    e.target.reset();
    await loadState();
  });
});

$("logout-btn").addEventListener("click", async () => {
  await withPending($("logout-btn"), $("global-error"), async () => {
    await api("POST", "/api/logout");
    showLogin();
  });
});

$("refresh-btn").addEventListener("click", () => withPending($("refresh-btn"), $("global-error"), loadState));

$("run-btn").addEventListener("click", async () => {
  const button = $("run-btn");
  button.textContent = "Checking…";
  await withPending(button, $("global-error"), async () => {
    const { status, slots } = await api("POST", "/api/run");
    state.status = status;
    state.slots = slots;
    render();
  });
  button.textContent = "Check now";
});

async function saveSettings(button, errorEl, changes) {
  return withPending(button, errorEl, async () => {
    const { settings, status } = await api("PUT", "/api/settings", { ...state.settings, ...changes });
    state.settings = settings;
    state.status = status;
    render();
    return true;
  });
}

$("pause-btn").addEventListener("click", () =>
  saveSettings($("pause-btn"), $("global-error"), { paused: !state.settings.paused }),
);

$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  $("settings-message").textContent = "";
  const probeChanged = f.probeCaseNumber.value.trim().toUpperCase() !== state.settings.probeCaseNumber;
  const ok = await saveSettings($("settings-save-btn"), $("settings-error"), {
    pollIntervalMinutes: Number(f.pollIntervalMinutes.value),
    probeCaseNumber: f.probeCaseNumber.value,
    recipients: f.recipients.value.split(/[\s,;]+/).filter(Boolean),
  });
  if (ok) {
    if (probeChanged) state.catalog = null;
    $("settings-message").textContent = "Settings saved.";
  }
});

$("test-email-btn").addEventListener("click", async () => {
  $("settings-message").textContent = "";
  const result = await withPending($("test-email-btn"), $("settings-error"), () => api("POST", "/api/test-email"));
  if (result) $("settings-message").textContent = `Test email sent to ${result.sentTo.join(", ")}.`;
});

$("add-watch-btn").addEventListener("click", () => openWatchForm(null));
$("watch-cancel-btn").addEventListener("click", closeWatchForm);
$("watch-form").courthouseCode.addEventListener("change", (e) =>
  loadDepartments(e.target.value, "").catch((err) => ($("watch-form-error").textContent = err.message)),
);
$("dept-select-all").addEventListener("change", (e) => {
  for (const box of $("dept-boxes").querySelectorAll("input[name=department]")) box.checked = e.target.checked;
});
for (const radio of $("watch-form").querySelectorAll("input[name=rangeMode]")) {
  radio.addEventListener("change", syncRangeVisibility);
}

$("watch-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = watchPayload(e.target);
  await withPending($("watch-save-btn"), $("watch-form-error"), async () => {
    if (editingId === 0) {
      const { watches } = await api("POST", "/api/watches", payload);
      state.watches = [...state.watches, ...watches].sort((a, b) => a.id - b.id);
    } else {
      const { watch, slots } = await api("PUT", `/api/watches/${editingId}`, payload);
      applyWatchUpdate(watch, slots);
    }
    closeWatchForm();
    render();
  });
});

$("watches").addEventListener("click", async (e) => {
  const button = e.target.closest("button[data-action]");
  if (!button) return;
  const watch = state.watches.find((w) => w.id === Number(button.dataset.id));
  if (!watch) return;
  const action = button.dataset.action;
  if (action === "edit") {
    openWatchForm(watch);
  } else if (action === "toggle") {
    await withPending(button, $("global-error"), async () => {
      const { watch: updated, slots } = await api("PUT", `/api/watches/${watch.id}`, { ...watch, active: !watch.active });
      applyWatchUpdate(updated, slots);
      render();
    });
  } else if (action === "delete" && confirm(`Delete watch “${watch.label}”?`)) {
    await withPending(button, $("global-error"), async () => {
      await api("DELETE", `/api/watches/${watch.id}`);
      state.watches = state.watches.filter((w) => w.id !== watch.id);
      state.slots = state.slots.filter((s) => s.watchId !== watch.id);
      if (editingId === watch.id) closeWatchForm();
      render();
    });
  }
});

loadState().catch((e) => {
  if (e instanceof Unauthorized) showLogin();
  else {
    $("app-view").hidden = false;
    $("global-error").textContent = e.message;
  }
});
