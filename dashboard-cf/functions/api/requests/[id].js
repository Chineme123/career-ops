// Cloudflare Pages Function — single-resource endpoint mapped to /api/requests/:id
//
//   GET   /api/requests/:id  → fetch one request
//   PATCH /api/requests/:id  → { status?, result? }  (used by the session to write back)
//
// D1 binding: context.env.DB. SECURITY: parameterized queries only; `status`
// validated against a fixed allowlist. `done_at` is stamped by the server when
// status flips to a terminal state ('done' | 'error').

const STATUSES = new Set(['pending', 'working', 'done', 'error']);
const TERMINAL = new Set(['done', 'error']);

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function parseId(params) {
  const id = Number.parseInt(params?.id, 10);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function onRequestGet(context) {
  const { env, params } = context;
  const id = parseId(params);
  if (id === null) return json({ error: 'Invalid id' }, 400);
  try {
    const row = await env.DB.prepare('SELECT * FROM requests WHERE id = ?').bind(id).first();
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
  try { body = await request.json(); } catch { return json({ error: 'Invalid JSON body' }, 400); }

  const sets = [];
  const values = [];

  if (Object.prototype.hasOwnProperty.call(body, 'status')) {
    const status = (body.status ?? '').toString().trim();
    if (!STATUSES.has(status)) {
      return json({ error: `Invalid status "${status}". Must be one of: ${[...STATUSES].join(', ')}` }, 400);
    }
    sets.push('status = ?');
    values.push(status);
    // Stamp/clear done_at based on whether we're entering a terminal state.
    sets.push('done_at = ?');
    values.push(TERMINAL.has(status) ? new Date().toISOString() : null);
  }

  if (Object.prototype.hasOwnProperty.call(body, 'result')) {
    sets.push('result = ?');
    values.push(body.result === null ? null : body.result.toString());
  }

  if (sets.length === 0) return json({ error: 'No editable fields provided (status, result)' }, 400);

  values.push(id);
  const sql = `UPDATE requests SET ${sets.join(', ')} WHERE id = ?`;
  try {
    const result = await env.DB.prepare(sql).bind(...values).run();
    if (!(result?.meta?.changes)) return json({ error: 'Not found' }, 404);
  } catch (err) {
    return json({ error: 'Update failed', detail: String(err) }, 500);
  }

  const row = await env.DB.prepare('SELECT * FROM requests WHERE id = ?').bind(id).first();
  return json(row);
}
