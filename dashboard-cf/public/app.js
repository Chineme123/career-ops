/* career-ops dashboard — client logic (vanilla JS, no framework).
 * Talks to the Pages Functions API at /api/jobs (same-origin).
 *   GET    /api/jobs        list
 *   POST   /api/jobs        add
 *   PATCH  /api/jobs/:id    update status/notes/fields
 *   DELETE /api/jobs/:id    remove
 */

/* Canonical statuses — MIRRORS templates/states.yml (the source of truth).
 * The API validates against the same set; keep both in sync if states.yml changes. */
const STATUSES = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Rejected', 'Discarded', 'SKIP'];

const state = {
  jobs: [],            // full list from the API
  search: '',
  statusFilter: null,  // one canonical status, or null for "all"
  open: new Set(),     // ids of expanded rows (preserved across re-renders)
  saving: new Set(),   // ids with an in-flight write (guards double submits)
};

const $ = (sel, root = document) => root.querySelector(sel);

/* ------------------------------------------------------------------ utils */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function scoreBand(score) {
  if (score === null || score === undefined || score === '' || Number.isNaN(Number(score))) return 'none';
  const n = Number(score);
  if (n >= 4.0) return 'apply';
  if (n >= 3.0) return 'research';
  return 'skip';
}
const BAND_LABEL = { apply: 'Apply', research: 'Research first', skip: 'Skip', none: 'Unscored' };

function fmtScore(score) {
  if (score === null || score === undefined || score === '' || Number.isNaN(Number(score))) return '—';
  const n = Number(score);
  return (Number.isInteger(n) ? n.toFixed(1) : String(n)) + '/5';
}

function isUrl(v) { return /^https?:\/\//i.test(String(v || '').trim()); }
function looksLinkable(v) {
  const s = String(v || '').trim();
  return isUrl(s) || /\.(md|pdf|html?)$/i.test(s);
}

/* split a strengths/gaps blob into items (newline / semicolon / pipe separated) */
function splitItems(v) {
  return String(v || '')
    .split(/\r?\n|;|\s\|\s/)
    .map((s) => s.replace(/^[\s\-*•]+/, '').trim())
    .filter(Boolean);
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ------------------------------------------------------------------ API */
async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const msg = (payload && (payload.error || payload.detail)) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return payload;
}

async function loadJobs() {
  showState('loading');
  try {
    const jobs = await api('/api/jobs');
    state.jobs = Array.isArray(jobs) ? jobs : [];
    render();
  } catch (err) {
    showState('error', err.message);
  }
}

/* ------------------------------------------------------------------ states */
function showState(which, detail) {
  const map = {
    loading: '#loading-state',
    empty: '#empty-state',
    noresults: '#no-results-state',
    error: '#error-state',
  };
  for (const key of Object.keys(map)) $(map[key]).hidden = key !== which;
  $('#list').hidden = which !== null;
  if (which === 'error' && detail) $('#error-detail').textContent = detail;
}

/* ------------------------------------------------------------------ counts */
function renderCounts() {
  const counts = {};
  for (const s of STATUSES) counts[s] = 0;
  for (const j of state.jobs) if (counts[j.status] !== undefined) counts[j.status] += 1;

  const total = state.jobs.length;
  let html = `<span class="count-chip count-chip--total"><span class="n">${total}</span> total</span>`;

  for (const s of STATUSES) {
    if (!counts[s]) continue; // only show statuses that are present
    const pressed = state.statusFilter === s;
    html += `<button class="count-chip" type="button" data-status="${esc(s)}" aria-pressed="${pressed}">
      <span class="dot"></span><span class="n">${counts[s]}</span> ${esc(s)}
    </button>`;
  }
  $('#counts').innerHTML = html;
}

/* ------------------------------------------------------------------ filter */
function visibleJobs() {
  const q = state.search.trim().toLowerCase();
  return state.jobs.filter((j) => {
    if (state.statusFilter && j.status !== state.statusFilter) return false;
    if (q) {
      const hay = `${j.company || ''} ${j.role || ''} ${j.notes || ''} ${j.location || ''} ${j.verdict || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/* ------------------------------------------------------------------ render */
function fieldRow(label, valueHtml, wide = false, muted = false) {
  if (valueHtml === null || valueHtml === undefined || valueHtml === '') return '';
  return `<div class="field${wide ? ' field--wide' : ''}">
    <div class="field__label">${esc(label)}</div>
    <div class="field__value${muted ? ' field__value--muted' : ''}">${valueHtml}</div>
  </div>`;
}

function linkOrText(value, label) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (looksLinkable(v)) {
    return `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(label || v)} ↗</a>`;
  }
  return esc(v);
}

function pdfCell(v) {
  const s = String(v || '').trim();
  if (!s || s === '❌' || s === '-' || s === '—') return '<span class="field__value--muted">—</span>';
  if (/^(✅|✓|ready|yes|true)$/i.test(s)) return '<span class="pill pill--good">Ready</span>';
  if (looksLinkable(s)) return `<a href="${esc(s)}" target="_blank" rel="noopener">Open PDF ↗</a>`;
  return `<span class="field__value--muted">${esc(s)}</span>`;
}

function itemPills(v, kind) {
  const items = splitItems(v);
  if (!items.length) return '';
  const cls = kind === 'good' ? 'pill pill--good' : (kind === 'gap' ? 'pill pill--gap' : 'pill');
  return `<div class="chips-inline">${items.map((i) => `<span class="${cls}">${esc(i)}</span>`).join('')}</div>`;
}

function jobPanel(j) {
  const bandCaption = j.score === null || j.score === undefined || j.score === '' ? '' : ` · ${BAND_LABEL[scoreBand(j.score)]}`;
  const fields = [
    fieldRow('Date', j.date ? esc(j.date) : ''),
    fieldRow('Score', `${esc(fmtScore(j.score))}${bandCaption}`),
    fieldRow('Location', j.location ? esc(j.location) : ''),
    fieldRow('URL', linkOrText(j.url, 'Job posting'), false, !j.url),
    fieldRow('Report', linkOrText(j.report, 'Report'), false, !j.report),
    fieldRow('PDF', pdfCell(j.pdf)),
    fieldRow('Updated', j.updated_at ? esc(String(j.updated_at).replace('T', ' ').replace(/\.\d+Z$/, ' UTC')) : '', false, true),
    fieldRow('Verdict', j.verdict ? esc(j.verdict) : '', true),
    fieldRow('Strengths', itemPills(j.strengths, 'good'), true),
    fieldRow('Gaps', itemPills(j.gaps, 'gap'), true),
  ].filter(Boolean).join('');

  const statusOptions = STATUSES.map(
    (s) => `<option value="${esc(s)}"${s === j.status ? ' selected' : ''}>${esc(s)}</option>`
  ).join('');

  return `<div class="job__panel"><div class="job__panel-inner"><div class="job__body">
    <div class="fields">${fields || '<div class="field__value field__value--muted">No extra details.</div>'}</div>
    <div class="editor">
      <div class="editor__row">
        <div class="control">
          <label class="control__label" for="status-${j.id}">Status</label>
          <select class="status-select" id="status-${j.id}" data-act="status" data-id="${j.id}">${statusOptions}</select>
        </div>
        <div class="control notes-field">
          <label class="control__label" for="notes-${j.id}">Notes</label>
          <textarea class="notes-input" id="notes-${j.id}" data-id="${j.id}" rows="2" placeholder="Private notes…">${esc(j.notes)}</textarea>
        </div>
      </div>
      <div class="editor__actions">
        <span class="editor__meta">#${esc(j.id)}</span>
        <button class="btn btn--danger btn--sm" type="button" data-act="delete" data-id="${j.id}">Delete</button>
        <button class="btn btn--primary btn--sm" type="button" data-act="save" data-id="${j.id}">Save notes</button>
      </div>
      <div class="claude-actions">
        <div class="claude-actions__label">Ask Claude <span class="claude-actions__hint">— queues for your live session</span></div>
        <div class="claude-actions__btns">
          <button class="btn btn--ghost btn--sm" type="button" data-act="request" data-action="cv" data-id="${j.id}">Generate CV</button>
          <button class="btn btn--ghost btn--sm" type="button" data-act="request" data-action="cl" data-id="${j.id}">Generate CL</button>
          <button class="btn btn--ghost btn--sm" type="button" data-act="request" data-action="verify" data-id="${j.id}">Verify</button>
          <button class="btn btn--ghost btn--sm" type="button" data-act="request" data-action="autofill" data-id="${j.id}">Autofill</button>
        </div>
        <div class="claude-reqs" id="reqs-${j.id}"></div>
      </div>
    </div>
  </div></div></div>`;
}

function jobCard(j) {
  const open = state.open.has(j.id);
  const band = scoreBand(j.score);
  const statusClass = STATUSES.includes(j.status) ? `badge--${j.status}` : 'badge--Evaluated';
  return `<div class="job${open ? ' open' : ''}" role="listitem" data-id="${j.id}">
    <button class="job__summary" type="button" data-act="toggle" data-id="${j.id}"
            aria-expanded="${open}" aria-controls="panel-${j.id}">
      <span class="job__num">#${esc(j.id)}</span>
      <span class="job__company">${esc(j.company) || '<span class="field__value--muted">—</span>'}</span>
      <span class="job__role">${esc(j.role)}</span>
      <span class="score score--${band}">${esc(fmtScore(j.score))}</span>
      <span class="badge ${statusClass}">${esc(j.status || 'Evaluated')}</span>
      <svg class="job__chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><polyline points="9 18 15 12 9 6" /></svg>
    </button>
    <div id="panel-${j.id}">${jobPanel(j)}</div>
  </div>`;
}

function render() {
  renderCounts();

  if (state.jobs.length === 0) { showState('empty'); $('#list').innerHTML = ''; return; }

  const rows = visibleJobs();
  if (rows.length === 0) { showState('noresults'); $('#list').innerHTML = ''; return; }

  showState(null);
  $('#list').innerHTML = rows.map(jobCard).join('');
}

/* ------------------------------------------------------------------ actions */
function getJob(id) { return state.jobs.find((j) => String(j.id) === String(id)); }

function toggle(id) {
  const key = Number(id);
  if (state.open.has(key)) state.open.delete(key); else state.open.add(key);
  const card = $(`.job[data-id="${CSS.escape(String(id))}"]`);
  if (card) {
    const isOpen = state.open.has(key);
    card.classList.toggle('open', isOpen);
    const btn = card.querySelector('.job__summary');
    if (btn) btn.setAttribute('aria-expanded', String(isOpen));
    if (isOpen) loadJobRequests(id);
  }
}

async function changeStatus(id, newStatus) {
  const job = getJob(id);
  if (!job || job.status === newStatus) return;
  const prev = job.status;
  job.status = newStatus;         // optimistic
  renderCounts();
  updateBadge(id, newStatus);
  try {
    const updated = await api(`/api/jobs/${id}`, { method: 'PATCH', body: JSON.stringify({ status: newStatus }) });
    Object.assign(job, updated);
    toast(`#${id} → ${newStatus}`);
  } catch (err) {
    job.status = prev;            // revert
    renderCounts();
    updateBadge(id, prev);
    const sel = $(`#status-${CSS.escape(String(id))}`);
    if (sel) sel.value = prev;
    toast(`Save failed: ${err.message}`, true);
  }
}

function updateBadge(id, status) {
  const card = $(`.job[data-id="${CSS.escape(String(id))}"]`);
  if (!card) return;
  const badge = card.querySelector('.job__summary .badge');
  if (badge) {
    badge.className = `badge badge--${STATUSES.includes(status) ? status : 'Evaluated'}`;
    badge.textContent = status;
  }
}

async function saveNotes(id) {
  const job = getJob(id);
  if (!job || state.saving.has(String(id))) return;
  const ta = $(`#notes-${CSS.escape(String(id))}`);
  const sel = $(`#status-${CSS.escape(String(id))}`);
  const notes = ta ? ta.value : '';
  const status = sel ? sel.value : job.status;
  const patch = { notes };
  if (status && status !== job.status) patch.status = status;

  state.saving.add(String(id));
  try {
    const updated = await api(`/api/jobs/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    Object.assign(job, updated);
    renderCounts();
    updateBadge(id, job.status);
    toast(`#${id} saved`);
  } catch (err) {
    toast(`Save failed: ${err.message}`, true);
  } finally {
    state.saving.delete(String(id));
  }
}

async function deleteJob(id) {
  const job = getJob(id);
  if (!job) return;
  const label = job.company || job.role || `#${id}`;
  if (!confirm(`Delete “${label}” (#${id})? This cannot be undone.`)) return;
  try {
    await api(`/api/jobs/${id}`, { method: 'DELETE' });
    state.jobs = state.jobs.filter((j) => String(j.id) !== String(id));
    state.open.delete(Number(id));
    render();
    toast(`#${id} deleted`);
  } catch (err) {
    toast(`Delete failed: ${err.message}`, true);
  }
}

/* ---------------------------------------------- Claude request queue (D1 bus) */
const ACTION_LABEL = { cv: 'Generate CV', cl: 'Generate CL', verify: 'Verify', autofill: 'Autofill' };

async function queueRequest(id, action) {
  if (!ACTION_LABEL[action]) return;
  try {
    await api('/api/requests', { method: 'POST', body: JSON.stringify({ job_id: Number(id), action }) });
    toast(`Queued: ${ACTION_LABEL[action]} · #${id}`);
    loadJobRequests(id);
  } catch (err) {
    toast(`Queue failed: ${err.message}`, true);
  }
}

async function loadJobRequests(id) {
  const box = $(`#reqs-${CSS.escape(String(id))}`);
  if (!box) return;
  try {
    const reqs = await api(`/api/requests?job_id=${encodeURIComponent(id)}`);
    renderJobRequests(box, Array.isArray(reqs) ? reqs : []);
  } catch { /* silent — the queue is a convenience, not core */ }
}

function renderJobRequests(box, reqs) {
  if (!reqs.length) { box.innerHTML = ''; return; }
  box.innerHTML = reqs.slice(0, 6).map((r) => {
    const st = String(r.status || 'pending');
    const when = r.done_at || r.created_at || '';
    const result = r.result
      ? `<div class="claude-req__result">${looksLinkable(r.result) ? linkOrText(r.result, 'open') : esc(r.result)}</div>`
      : '';
    return `<div class="claude-req claude-req--${esc(st)}">
      <span class="claude-req__dot"></span>
      <span class="claude-req__action">${esc(ACTION_LABEL[r.action] || r.action)}</span>
      <span class="claude-req__status">${esc(st)}</span>
      <span class="claude-req__when">${esc(String(when).slice(0, 16).replace('T', ' '))}</span>
      ${result}
    </div>`;
  }).join('');
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state.jobs, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `career-ops-jobs-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`Exported ${state.jobs.length} job${state.jobs.length === 1 ? '' : 's'}`);
}

/* ------------------------------------------------------------------ add modal */
function openAddModal() {
  const m = $('#add-modal');
  $('#add-form').reset();
  $('#f-date').value = new Date().toISOString().slice(0, 10);
  $('#f-status').value = 'Evaluated';
  m.hidden = false;
  setTimeout(() => $('#f-company').focus(), 30);
}
function closeAddModal() { $('#add-modal').hidden = true; }

async function submitAdd(e) {
  e.preventDefault();
  const form = e.target;
  const data = Object.fromEntries(new FormData(form).entries());
  if (!String(data.company || '').trim() && !String(data.role || '').trim()) {
    toast('Company or role is required', true);
    return;
  }
  try {
    const created = await api('/api/jobs', { method: 'POST', body: JSON.stringify(data) });
    state.jobs.unshift(created);
    if (created && created.id != null) state.open.add(Number(created.id));
    // keep newest-first ordering by id
    state.jobs.sort((a, b) => Number(b.id) - Number(a.id));
    closeAddModal();
    render();
    toast(`Added #${created.id} · ${created.company || created.role}`);
  } catch (err) {
    toast(`Add failed: ${err.message}`, true);
  }
}

/* ------------------------------------------------------------------ wiring */
function init() {
  // populate the add-form status dropdown from the canonical list
  $('#f-status').innerHTML = STATUSES.map((s) => `<option value="${s}">${s}</option>`).join('');

  // search
  $('#search').addEventListener('input', (e) => { state.search = e.target.value; render(); });

  // counts / status filter (event delegation)
  $('#counts').addEventListener('click', (e) => {
    const chip = e.target.closest('.count-chip[data-status]');
    if (!chip) return;
    const s = chip.dataset.status;
    state.statusFilter = state.statusFilter === s ? null : s;
    render();
  });

  // list interactions (event delegation)
  const list = $('#list');
  list.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const id = el.dataset.id;
    if (act === 'toggle') toggle(id);
    else if (act === 'save') saveNotes(id);
    else if (act === 'delete') deleteJob(id);
    else if (act === 'request') queueRequest(id, el.dataset.action);
  });
  list.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-act="status"]');
    if (sel) changeStatus(sel.dataset.id, sel.value);
  });
  // Ctrl/Cmd+Enter inside a notes textarea saves it
  list.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      const ta = e.target.closest('textarea.notes-input');
      if (ta) { e.preventDefault(); saveNotes(ta.dataset.id); }
    }
  });

  // toolbar buttons
  $('#add-btn').addEventListener('click', openAddModal);
  $('#export-btn').addEventListener('click', exportJson);

  // modal
  $('#add-close').addEventListener('click', closeAddModal);
  $('#add-cancel').addEventListener('click', closeAddModal);
  $('#add-form').addEventListener('submit', submitAdd);
  $('#add-modal').addEventListener('click', (e) => { if (e.target.id === 'add-modal') closeAddModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#add-modal').hidden) closeAddModal(); });

  loadJobs();
}

document.addEventListener('DOMContentLoaded', init);
