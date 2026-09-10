// Cloudflare Pages Function — single-resource endpoint mapped to /api/jobs/:id
// (file-based dynamic route: the [id] segment arrives as context.params.id)
//
//   GET    /api/jobs/:id → fetch one job
//   PATCH  /api/jobs/:id → update any provided editable fields (status, notes, ...)
//   DELETE /api/jobs/:id → delete the job
//
// D1 binding: context.env.DB. SECURITY: parameterized queries only. Column names
// in the dynamic UPDATE come from a fixed allowlist (EDITABLE) — never from raw
// request keys — and every value is a bound parameter.

const CANONICAL_STATUSES = new Set([
  'Evaluated', 'Applied', 'Responded', 'Interview',
  'Offer', 'Rejected', 'Discarded', 'SKIP',
]);

// Columns a PATCH may write. `id` and `updated_at` are managed by the server.
const EDITABLE = [
  'date', 'company', 'role', 'score', 'status',
  'pdf', 'report', 'url', 'location', 'verdict',
  'strengths', 'gaps', 'notes',
];

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

// See ../jobs.js for the Cloudflare Access (Cf-Access-Jwt-Assertion) note: edge
// Access is the primary gate; verify the JWT here for defense-in-depth if desired.

function parseId(params) {
  const id = Number.parseInt(params?.id, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function onRequestGet(context) {
  const { env, params } = context;
  const id = parseId(params);
  if (id === null) return json({ error: 'Invalid id' }, 400);

  try {
    const row = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'Not found' }, 404);
    return json(row);
  } catch (err) {
    return json({ error: 'Query failed', detail: String(err) }, 500);
  }
}

export async function onRequestPatch(context) {
  const { request, env, params } = context;
  const id = parseId(params);
  if (id === null) return json({ error: 'Invalid id' }, 400);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const sets = [];
  const values = [];

  for (const col of EDITABLE) {
    if (!Object.prototype.hasOwnProperty.call(body, col)) continue;

    if (col === 'status') {
      const status = (body.status ?? '').toString().trim();
      if (!CANONICAL_STATUSES.has(status)) {
        return json({
          error: `Invalid status "${status}". Must be one of: ${[...CANONICAL_STATUSES].join(', ')}`,
        }, 400);
      }
      sets.push('status = ?');
      values.push(status);
    } else if (col === 'score') {
      let score = null;
      if (body.score !== null && body.score !== '') {
        const n = Number(body.score);
        score = Number.isFinite(n) ? n : null;
      }
      sets.push('score = ?');
      values.push(score);
    } else {
      sets.push(`${col} = ?`);
      values.push(body[col] === null ? null : body[col].toString());
    }
  }

  if (sets.length === 0) {
    return json({ error: 'No editable fields provided' }, 400);
  }

  // Always stamp updated_at.
  sets.push('updated_at = ?');
  values.push(new Date().toISOString());

  // id last, for the WHERE clause.
  values.push(id);

  // Safe: column fragments come only from the EDITABLE allowlist above; all
  // dynamic values are bound parameters.
  const sql = `UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`;

  try {
    const result = await env.DB.prepare(sql).bind(...values).run();
    const changes = result?.meta?.changes ?? 0;
    if (!changes) return json({ error: 'Not found' }, 404);
  } catch (err) {
    return json({ error: 'Update failed', detail: String(err) }, 500);
  }

  const row = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first();
  return json(row);
}

export async function onRequestDelete(context) {
  const { env, params } = context;
  const id = parseId(params);
  if (id === null) return json({ error: 'Invalid id' }, 400);

  try {
    const result = await env.DB.prepare('DELETE FROM jobs WHERE id = ?').bind(id).run();
    const changes = result?.meta?.changes ?? 0;
    if (!changes) return json({ error: 'Not found' }, 404);
    return json({ ok: true, id });
  } catch (err) {
    return json({ error: 'Delete failed', detail: String(err) }, 500);
  }
}
