#!/usr/bin/env node
// sync-applications-to-d1.mjs
// -----------------------------------------------------------------------------
// Reads ../data/applications.md (the tracker), enriches each row from its
// matching ../reports/{num}-*.md "## Machine Summary" YAML, and emits an
// idempotent import.sql next to this script.
//
// Usage:
//   node sync-applications-to-d1.mjs
//   npx wrangler d1 execute career-ops-dashboard --remote --file=import.sql
//   (use --local instead of --remote to load your local preview DB)
//
// Idempotency: each row becomes an INSERT ... ON CONFLICT(id) DO UPDATE, so
// re-running never duplicates — it updates the existing row (matched by id,
// which mirrors the tracker's sequential number).
//
// IMPORTANT — what a re-sync preserves:
//   The DO UPDATE clause refreshes every evaluation-derived field (score,
//   verdict, strengths, gaps, url, location, links, ...) but intentionally does
//   NOT overwrite `status` and `notes` on rows that already exist. Those two are
//   the columns you edit live in the dashboard, so a re-sync won't wipe your
//   pipeline edits. (Brand-new rows still get status/notes seeded from the
//   tracker on first insert.) To change which columns are preserved, edit
//   PRESERVE_ON_CONFLICT below.
// -----------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..'); // career-ops repo root
const APPS_PATH = join(ROOT, 'data', 'applications.md');
const REPORTS_DIR = join(ROOT, 'reports');
const OUT_PATH = join(__dirname, 'import.sql');

// Column order for the generated INSERT statements (matches schema.sql).
const COLUMNS = [
  'id', 'date', 'company', 'role', 'score', 'status', 'pdf', 'report',
  'url', 'location', 'verdict', 'strengths', 'gaps', 'notes', 'updated_at',
];

// These columns are user-owned in the dashboard; a re-sync must not clobber them
// on rows that already exist. (New rows still receive them on first insert.)
const PRESERVE_ON_CONFLICT = new Set(['status', 'notes']);

// Machine Summary field aliases (schemas drift across older reports).
const ALIASES = {
  url: ['url'],
  location: ['location', 'remote', 'remote_policy', 'location_fit', 'remote_dim'],
  verdict: ['verdict', 'final_decision', 'recommendation', 'recommended_action', 'fit_summary', 'next_action'],
  strengths: ['strengths', 'top_strengths', 'key_strengths', 'fit_strengths', 'top_strength'],
  gaps: ['gaps', 'soft_gaps', 'key_gaps', 'hard_gaps', 'fit_gaps', 'blockers', 'red_flags'],
};

// --- optional js-yaml (declared dependency of the repo), with a mini fallback -
let yamlLoad = null;
try {
  const mod = await import('js-yaml');
  yamlLoad = mod.load || (mod.default && mod.default.load) || null;
} catch {
  yamlLoad = null; // fall back to the minimal parser below
}

// --- SQL escaping ------------------------------------------------------------
function sqlStr(v) {
  if (v === null || v === undefined) return 'NULL';
  const s = String(v);
  if (s === '') return 'NULL';
  return `'${s.replace(/'/g, "''")}'`;
}
function sqlNum(v) {
  if (v === null || v === undefined || v === '') return 'NULL';
  const n = Number(v);
  return Number.isFinite(n) ? String(n) : 'NULL';
}
function valueFor(col, row) {
  if (col === 'id' || col === 'score') return sqlNum(row[col]);
  return sqlStr(row[col]);
}

// --- tracker parsing ---------------------------------------------------------
// Row shape: | # | Date | Company | Role | Score | Status | PDF | Report | Notes |
function parseTracker(md) {
  return md.split('\n')
    .filter((line) => /^\|\s*\d+\s*\|/.test(line))
    .map((line) => {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      return {
        num: cells[0],
        date: cells[1] && cells[1] !== '-' ? cells[1] : '',
        company: cells[2] || '',
        role: cells[3] || '',
        score: parseScore(cells[4]),
        status: cells[5] || '',
        pdf: cells[6] || '',
        reportCell: cells[7] || '',
        notes: cells[8] || '',
      };
    });
}

function parseScore(cell) {
  if (!cell) return null;
  const m = String(cell).match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

// --- report lookup + Machine Summary parsing ---------------------------------
function findReportFile(num, reportCell) {
  const m = (reportCell || '').match(/reports\/([^)\s]+\.md)/);
  if (m) return m[1];
  if (!existsSync(REPORTS_DIR)) return null;
  const files = readdirSync(REPORTS_DIR).filter((f) => f.endsWith('.md'));
  const padded = String(num).padStart(3, '0');
  return files.find((f) => f.startsWith(padded + '-')) || files.find((f) => f.startsWith(num + '-')) || null;
}

function extractMachineSummary(text) {
  const idx = text.indexOf('## Machine Summary');
  if (idx === -1) return null;
  const after = text.slice(idx);
  const fence = after.match(/```ya?ml\s*\n([\s\S]*?)```/i) || after.match(/```\s*\n([\s\S]*?)```/);
  return fence ? fence[1] : null;
}

function extractHeaderUrl(text) {
  const m = text.match(/^\*\*URL:\*\*\s*(\S+)/m);
  return m ? m[1] : '';
}

function parseYamlBlock(block) {
  if (!block) return {};
  if (yamlLoad) {
    try {
      const obj = yamlLoad(block);
      if (obj && typeof obj === 'object') return obj;
    } catch { /* fall through to mini parser */ }
  }
  return miniParse(block);
}

// Minimal YAML subset parser (key: scalar, block lists, flow lists, []).
function miniParse(block) {
  const obj = {};
  let curKey = null;
  for (const raw of block.split('\n')) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const item = raw.match(/^\s+-\s+(.*)$/);
    if (item && curKey) {
      if (!Array.isArray(obj[curKey])) obj[curKey] = [];
      obj[curKey].push(stripQuotes(item[1]));
      continue;
    }
    const kv = raw.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const val = kv[2].trim();
      if (val === '') { obj[key] = ''; curKey = key; }
      else if (val === '[]') { obj[key] = []; curKey = null; }
      else if (val.startsWith('[') && val.endsWith(']')) {
        obj[key] = val.slice(1, -1).split(',').map((s) => stripQuotes(s)).filter(Boolean);
        curKey = null;
      } else { obj[key] = stripQuotes(val); curKey = null; }
    }
  }
  return obj;
}

function stripQuotes(s) {
  const t = String(s).trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

function firstOf(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    return v;
  }
  return null;
}

function toText(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map((x) => (x && typeof x === 'object' ? JSON.stringify(x) : String(x))).join('\n');
  if (typeof v === 'object') return Object.values(v).map((x) => String(x)).join('\n');
  return String(v);
}

// --- main --------------------------------------------------------------------
function main() {
  if (!existsSync(APPS_PATH)) {
    console.error(`✗ Tracker not found at ${APPS_PATH}`);
    writeFileSync(OUT_PATH, '-- No tracker found; nothing to sync.\n');
    process.exit(1);
  }

  const rows = parseTracker(readFileSync(APPS_PATH, 'utf8'));
  const now = new Date().toISOString();
  const statements = [];
  let enriched = 0;

  for (const r of rows) {
    const job = {
      id: parseInt(r.num, 10),
      date: r.date,
      company: r.company,
      role: r.role,
      score: r.score,
      status: r.status,
      pdf: r.pdf,
      report: '',
      url: '',
      location: '',
      verdict: '',
      strengths: '',
      gaps: '',
      notes: r.notes,
      updated_at: now,
    };

    const reportFile = findReportFile(r.num, r.reportCell);
    if (reportFile) {
      job.report = `reports/${reportFile}`;
      const full = join(REPORTS_DIR, reportFile);
      if (existsSync(full)) {
        const text = readFileSync(full, 'utf8');
        const ms = parseYamlBlock(extractMachineSummary(text));
        const headerUrl = extractHeaderUrl(text);
        job.url = toText(firstOf(ms, ALIASES.url)) || headerUrl;
        job.location = toText(firstOf(ms, ALIASES.location));
        job.verdict = toText(firstOf(ms, ALIASES.verdict));
        job.strengths = toText(firstOf(ms, ALIASES.strengths));
        job.gaps = toText(firstOf(ms, ALIASES.gaps));
        if (job.url || job.location || job.verdict || job.strengths || job.gaps) enriched += 1;
      }
    }

    const cols = COLUMNS.join(', ');
    const vals = COLUMNS.map((c) => valueFor(c, job)).join(', ');
    const updates = COLUMNS
      .filter((c) => c !== 'id' && !PRESERVE_ON_CONFLICT.has(c))
      .map((c) => `${c}=excluded.${c}`)
      .join(', ');
    statements.push(
      `INSERT INTO jobs (${cols})\nVALUES (${vals})\nON CONFLICT(id) DO UPDATE SET ${updates};`
    );
  }

  const header = [
    '-- Generated by sync-applications-to-d1.mjs',
    `-- ${now}`,
    `-- ${rows.length} row(s) from data/applications.md; ${enriched} enriched from reports/.`,
    `-- Idempotent: re-running updates rows by id and preserves dashboard-owned columns (${[...PRESERVE_ON_CONFLICT].join(', ')}).`,
    '',
  ].join('\n');

  writeFileSync(OUT_PATH, header + (statements.join('\n\n') || '-- (no rows)\n') + '\n');

  console.log(`✓ Wrote ${OUT_PATH}`);
  console.log(`  Rows: ${rows.length} | Enriched from reports: ${enriched} | YAML parser: ${yamlLoad ? 'js-yaml' : 'mini-fallback'}`);
  if (rows.length === 0) {
    console.log('  (Tracker is empty — 0 rows emitted. This is expected until evaluations land.)');
  } else {
    console.log('  Next: npx wrangler d1 execute career-ops-dashboard --remote --file=import.sql');
  }
}

main();
