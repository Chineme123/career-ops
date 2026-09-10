-- career-ops dashboard — D1 schema
-- Apply with:
--   npx wrangler d1 execute career-ops-dashboard --remote --file=schema.sql   (production)
--   npx wrangler d1 execute career-ops-dashboard --local  --file=schema.sql   (local preview)
--
-- `id` mirrors the sequential number in data/applications.md so a job keeps the
-- same identity across re-syncs. All writes set `updated_at` (ISO-8601 UTC).

CREATE TABLE IF NOT EXISTS jobs (
  id         INTEGER PRIMARY KEY,
  date       TEXT,
  company    TEXT,
  role       TEXT,
  score      REAL,
  status     TEXT,
  pdf        TEXT,
  report     TEXT,
  url        TEXT,
  location   TEXT,
  verdict    TEXT,
  strengths  TEXT,
  gaps       TEXT,
  notes      TEXT,
  updated_at TEXT
);

-- Status is the most common filter/sort dimension in the dashboard.
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
