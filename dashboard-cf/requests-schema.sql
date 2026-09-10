-- career-ops dashboard — request-queue schema (the "message bus" between the
-- dashboard buttons and a live Claude Code session).
-- Apply with:
--   npx wrangler d1 execute career-ops-dashboard --remote --file=requests-schema.sql
--
-- Flow: a dashboard button POSTs a row here (status 'pending'); a live Claude
-- Code session polls for pending rows, does the work (generate CV/CL, verify
-- liveness, prep autofill), writes a human-readable `result`, and flips status
-- to 'done' (or 'error'). The dashboard shows the result under the job.

CREATE TABLE IF NOT EXISTS requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id     INTEGER NOT NULL,          -- FK to jobs.id (not enforced; D1 is SQLite)
  action     TEXT NOT NULL,             -- 'cv' | 'cl' | 'verify' | 'autofill'
  status     TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'working' | 'done' | 'error'
  result     TEXT,                      -- text/URL written back by the session
  created_at TEXT NOT NULL,             -- ISO-8601 UTC
  done_at    TEXT                       -- ISO-8601 UTC, set on done/error
);

CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_job    ON requests(job_id);
