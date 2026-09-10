// Cloudflare Pages Function — collection endpoint mapped to /api/requests
//
//   GET  /api/requests?status=pending&job_id=12  → list requests (filters optional)
//   POST /api/requests  { job_id, action }        → queue a new pending request
//
// This is the "message bus": dashboard buttons POST a pending row here; a live
// Claude Code session polls (GET ?status=pending), does the work, and PATCHes
// the row (see ./requests/[id].js). D1 binding: context.env.DB.
// SECURITY: parameterized queries only; `action`/`status` validated against
// fixed allowlists — never built from raw request text.

const ACTIONS = new Set(['cv', 'cl', 'verify', 'autofill']);
const STATUSES = new Set(['pending', 'working', 'done', 'error']);

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

// Edge Cloudflare Access is the primary gate (see ./jobs.js for the JWT note).

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const status = url.searchParams.get('status');
  const jobId = url.searchParams.get('job_id');

  const where = [];
  const binds = [];
  if (status) {
    if (!STATUSES.has(status)) return json({ error: `Invalid status "${status}"` }, 400);
    where.push('status = ?');
    binds.push(status);
  }
  if (jobId) {
    const n = Number.parseInt(jobId, 10);
    if (!Number.isInteger(n)) return json({ error: 'Invalid job_id' }, 400);
    where.push('job_id = ?');
    binds.push(n);
  }
  const sql = `SELECT * FROM requests${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`;
  try {
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return json(results ?? []);
  } catch (err) {
    return json({ error: 'Failed to load requests', detail: String(err) }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

  const jobId = Number.parseInt(body.job_id, 10);
  if (!Number.isInteger(jobId) || jobId <= 0) return json({ error: 'job_id is required' }, 400);

  const action = (body.action ?? '').toString().trim().toLowerCase();
  if (!ACTIONS.has(action)) {
    return json({ error: `Invalid action "${action}". Must be one of: ${[...ACTIONS].join(', ')}` }, 400);
  }

  // Guard against pile-ups: if an identical action is already pending/working
  // for this job, return that one instead of stacking duplicates.
  try {
    const existing = await env.DB
      .prepare(`SELECT * FROM requests WHERE job_id = ? AND action = ? AND status IN ('pending','working') ORDER BY id DESC LIMIT 1`)
      .bind(jobId, action).first();
    if (existing) return json(existing, 200);
  } catch { /* fall through to insert */ }

  const now = new Date().toISOString();
  try {
    const res = await env.DB
      .prepare(`INSERT INTO requests (job_id, action, status, result, created_at, done_at) VALUES (?, ?, 'pending', NULL, ?, NULL)`)
      .bind(jobId, action, now).run();
    const id = res?.meta?.last_row_id;
    const created = await env.DB.prepare('SELECT * FROM requests WHERE id = ?').bind(id).first();
    return json(created, 201);
  } catch (err) {
    return json({ error: 'Insert failed', detail: String(err) }, 500);
  }
}
