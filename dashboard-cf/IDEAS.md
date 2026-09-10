# Dashboard — future ideas

## Action buttons → live-session request queue (proposed 2026-09-01)

Per-job buttons on jobs.chineme.dev — **Generate CV**, **Generate CL**, **Verify**, **Autofill** —
that dispatch work to a running Claude Code session.

**Mechanism (D1 as a message bus):**
1. New D1 table `requests`: `id, job_id, action, status(pending|done|error), result, created_at, done_at`.
2. Each accordion gets the 4 buttons → `POST /api/requests {job_id, action}` (gated API) → inserts a pending row.
3. A live Claude Code session polls D1 (`wrangler d1 execute "SELECT … WHERE status='pending'"`) every ~30–60s,
   fulfills each (spawn CV/CL agent, browser-verify liveness, prep autofill), writes results back to the job row
   (`cv_url, cl_url, verdict, status`) + marks the request done. Dashboard reflects it.

**Honest limitation:**
- Only *fulfilled* while a session is actively polling; buttons just *queue* otherwise (a web button can't wake a closed terminal).
- Generate CV / CL + Verify: fulfillable headless (even a scheduled poller, if pointed at the right data).
- Autofill: needs a LOCAL session with the Chrome MCP + the user present (never auto-submit) → local-session-only.

**Status:** ✅ **BUILT & DEPLOYED 2026-09-02.**
- D1 table `requests` (id, job_id, action, status, result, created_at, done_at) — created.
- API: `functions/api/requests.js` (GET list / POST queue) + `functions/api/requests/[id].js` (PATCH write-back). Access-gated at the edge; parameterized queries; dedupes an identical pending/working action per job.
- Frontend: 4 buttons per job (Generate CV / CL / Verify / Autofill) → POST `/api/requests`; per-job live status list (loads on panel open, colored dot: pending→amber, working→blue-pulse, done→green, error→blush).
- Poller: `poll-requests.mjs` — a live Claude Code session runs `list` → fulfills each (spawn CV/CL agent, browser-verify, prep autofill; NEVER auto-submit) → `done <id> "result"` / `error <id> "result"`. Talks to D1 directly (bypasses Access, like the sync scripts).
- Honest limits UNCHANGED: only fulfilled while a session is actively polling; a web button can't wake a closed terminal. Autofill needs a LOCAL session with the Chrome MCP + user present.
