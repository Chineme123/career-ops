#!/usr/bin/env node
/*
 * poll-requests.mjs — CLI for the dashboard request queue (the D1 "message bus").
 *
 * A dashboard button (jobs.chineme.dev) POSTs a pending row; a LIVE Claude Code
 * session runs `list`, fulfills each request (generate CV/CL, browser-verify
 * liveness, prep autofill — NEVER auto-submit), then writes the outcome back.
 *
 *   node poll-requests.mjs list                    # pending + working, with job context
 *   node poll-requests.mjs claim <reqId>           # mark 'working' (you started it)
 *   node poll-requests.mjs done  <reqId> "result"  # mark 'done' + write result
 *   node poll-requests.mjs error <reqId> "result"  # mark 'error' + write result
 *   node poll-requests.mjs all                     # last 30 requests, any status
 *
 * Talks to D1 directly via `wrangler d1 execute` (same as sync-applications-to-d1.mjs),
 * so it is NOT blocked by Cloudflare Access. Honest limits: requests are only
 * FULFILLED while a session is actively running this; otherwise they just queue.
 * Autofill needs a local session with the Chrome MCP + you present.
 */

import { execFileSync } from 'node:child_process';

const DB = 'career-ops-dashboard';

function d1(sql) {
  const out = execFileSync(
    'npx',
    ['--yes', 'wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const parsed = JSON.parse(out);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  return (first && first.results) || [];
}
const q = (s) => String(s).replace(/'/g, "''"); // SQL single-quote escape

const [cmd, id, ...rest] = process.argv.slice(2);
const result = rest.join(' ');
const reqId = Number.parseInt(id, 10);

function requireId() {
  if (!Number.isInteger(reqId) || reqId <= 0) {
    console.error('A numeric request id is required.');
    process.exit(1);
  }
}

switch (cmd) {
  case undefined:
  case 'list': {
    const rows = d1(
      `SELECT r.id, r.job_id, r.action, r.status, r.created_at, j.company, j.role, j.url
         FROM requests r LEFT JOIN jobs j ON j.id = r.job_id
        WHERE r.status IN ('pending','working')
        ORDER BY r.id ASC`,
    );
    if (!rows.length) { console.log('✅ No pending requests.'); break; }
    console.log(`${rows.length} open request(s):\n`);
    for (const r of rows) {
      console.log(`  #${r.id}  [${r.status}]  ${String(r.action).toUpperCase()}`);
      console.log(`        job ${r.job_id}: ${r.company || '—'} — ${r.role || ''}`);
      if (r.url) console.log(`        ${r.url}`);
      console.log('');
    }
    break;
  }
  case 'claim': {
    requireId();
    d1(`UPDATE requests SET status='working' WHERE id=${reqId}`);
    console.log(`#${reqId} → working`);
    break;
  }
  case 'done':
  case 'error': {
    requireId();
    const st = cmd === 'done' ? 'done' : 'error';
    d1(`UPDATE requests SET status='${st}', result='${q(result)}', done_at='${new Date().toISOString()}' WHERE id=${reqId}`);
    console.log(`#${reqId} → ${st}${result ? ': ' + result : ''}`);
    break;
  }
  case 'all': {
    const rows = d1(`SELECT id, job_id, action, status, result FROM requests ORDER BY id DESC LIMIT 30`);
    if (!rows.length) { console.log('No requests yet.'); break; }
    for (const r of rows) {
      console.log(`#${r.id} [${r.status}] ${r.action} · job ${r.job_id}${r.result ? ' · ' + r.result : ''}`);
    }
    break;
  }
  default:
    console.log('Usage: node poll-requests.mjs list | claim <id> | done <id> "result" | error <id> "result" | all');
}
