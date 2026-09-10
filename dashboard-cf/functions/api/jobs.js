// Cloudflare Pages Function — collection endpoint mapped to /api/jobs
//
//   GET  /api/jobs  → list all jobs, newest id first
//   POST /api/jobs  → insert a new job from a JSON body
//
// The D1 database is available as context.env.DB (see wrangler.toml -> [[d1_databases]]).
// SECURITY: every query is parameterized via .prepare(sql).bind(...) — SQL text is
// NEVER built by concatenating request values.

// Canonical statuses — must stay in sync with ../../../templates/states.yml.
const CANONICAL_STATUSES = new Set([
  'Evaluated', 'Applied', 'Responded', 'Interview',
  'Offer', 'Rejected', 'Discarded', 'SKIP',
]);

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

// --- Defense-in-depth auth note ---------------------------------------------
// This app is meant to be gated at the edge by Cloudflare Access (Zero Trust).
// When Access is enabled, every allowed request carries a signed JWT in the
// `Cf-Access-Jwt-Assertion` header. Edge Access is the PRIMARY control.
//
// To add application-layer verification (belt-and-suspenders), read
//   context.request.headers.get('Cf-Access-Jwt-Assertion')
// and verify it against your team's public keys at
//   https://<your-team>.cloudflareaccess.com/cdn-cgi/access/certs
// (checking `aud` against your Access application AUD tag) before serving.
// We intentionally DO NOT hard-require the header here so that local
// `wrangler pages dev` (which has no Access proxy in front of it) still works.
// ---------------------------------------------------------------------------

export async function onRequestGet(context) {
  const { env } = context;
  try {
    const { results } = await env.DB
      .prepare('SELECT * FROM jobs ORDER BY id DESC')
      .all();
    return json(results ?? []);
  } catch (err) {
    return json({ error: 'Failed to load jobs', detail: String(err) }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const company = (body.company ?? '').toString().trim();
  const role = (body.role ?? '').toString().trim();
  if (!company && !role) {
    return json({ error: 'company or role is required' }, 400);
  }

  // Status: default to Evaluated; reject anything non-canonical.
  const status = (body.status ?? 'Evaluated').toString().trim();
  if (!CANONICAL_STATUSES.has(status)) {
    return json({
      error: `Invalid status "${status}". Must be one of: ${[...CANONICAL_STATUSES].join(', ')}`,
    }, 400);
  }

  const now = new Date().toISOString();
  const date = (body.date ?? now.slice(0, 10)).toString();

  // id: use a valid supplied id, else MAX(id)+1 to mirror the tracker's
  // sequential numbering (data/applications.md).
  let id = Number.parseInt(body.id, 10);
  if (!Number.isInteger(id) || id <= 0) {
    try {
      const row = await env.DB
        .prepare('SELECT COALESCE(MAX(id), 0) + 1 AS next FROM jobs')
        .first();
      id = row ? row.next : 1;
    } catch (err) {
      return json({ error: 'Failed to allocate id', detail: String(err) }, 500);
    }
  }

  // score: numeric or null (never NaN in the DB).
  let score = null;
  if (body.score !== undefined && body.score !== null && body.score !== '') {
    const n = Number(body.score);
    score = Number.isFinite(n) ? n : null;
  }

  try {
    await env.DB.prepare(
      `INSERT INTO jobs
        (id, date, company, role, score, status, pdf, report, url, location, verdict, strengths, gaps, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      date,
      company,
      role,
      score,
      status,
      (body.pdf ?? '').toString(),
      (body.report ?? '').toString(),
      (body.url ?? '').toString(),
      (body.location ?? '').toString(),
      (body.verdict ?? '').toString(),
      (body.strengths ?? '').toString(),
      (body.gaps ?? '').toString(),
      (body.notes ?? '').toString(),
      now,
    ).run();
  } catch (err) {
    // Most likely an id collision (UNIQUE/PRIMARY KEY) if a caller supplied one.
    return json({ error: 'Insert failed', detail: String(err) }, 500);
  }

  const created = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(id).first();
  return json(created, 201);
}
