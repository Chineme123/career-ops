# career-ops dashboard — Cloudflare Pages + Functions + D1

A warm "paper"-themed job-search dashboard.
Static frontend on **Cloudflare Pages**, a small JSON API on **Pages Functions**, data in
**Cloudflare D1** (serverless SQLite). Gated privately with **Cloudflare Access** (free).

Each job is a collapsible **accordion** row. Expand it to see everything (date, score + basis,
location, verdict, strengths/gaps, links) and to edit the two live fields — **status** (canonical
dropdown) and **notes** — plus add and delete jobs.

```
dashboard-cf/
├── public/                 # static site (deployed to Pages)
│   ├── index.html
│   ├── styles.css          # chineme.dev "paper" palette + Hanken Grotesk
│   └── app.js              # vanilla JS: fetch, accordion, edit, add, delete, search, export
├── functions/api/          # Cloudflare Pages Functions (file-based routing)
│   ├── jobs.js             # GET /api/jobs (list), POST /api/jobs (add)
│   └── jobs/[id].js        # GET/PATCH/DELETE /api/jobs/:id
├── schema.sql              # D1 table + index
├── wrangler.toml           # Pages config + D1 binding (DB)
├── sync-applications-to-d1.mjs   # tracker + reports -> import.sql
├── package.json            # ESM + convenience npm scripts
└── README.md
```

> **Legend** — 🧍 = a step only you can do in a browser (Cloudflare login / dashboard clicks).
> 🤖 = a command anyone can run once you are logged in.

---

## Prerequisites

- Node.js (already used by career-ops).
- A Cloudflare account (free plan is enough for Pages + D1 + Access).

---

## 1. 🤖 Install wrangler

From inside `dashboard-cf/`:

```bash
npm install -D wrangler
```

(Or skip installing and prefix every command below with `npx` — e.g. `npx wrangler login`.)

## 2. 🧍 HER — log in to Cloudflare

```bash
npx wrangler login
```

This opens a browser for Cloudflare OAuth. **Only you can approve this** — it authenticates
wrangler against your Cloudflare account. Nothing below works until this succeeds.

## 3. 🤖 Create the D1 database and paste its id

```bash
npx wrangler d1 create career-ops-dashboard
```

Wrangler prints a `database_id` (a UUID) and a ready-to-copy `[[d1_databases]]` block. Open
**`wrangler.toml`** and replace the placeholder:

```toml
[[d1_databases]]
binding = "DB"
database_name = "career-ops-dashboard"
database_id = "REPLACE_AFTER_wrangler_d1_create"   # <- paste the UUID here
```

## 4. 🤖 Create the table (remote D1)

```bash
npx wrangler d1 execute career-ops-dashboard --remote --file=schema.sql
```

`--remote` targets the real (deployed) database. (`--local` targets the on-disk dev copy used by
`wrangler pages dev` — see **Local preview** below.)

## 5. 🤖 Create the Pages project and deploy

```bash
npx wrangler pages project create career-ops-dashboard
npx wrangler pages deploy public
```

The deploy prints your site URL, e.g. `https://career-ops-dashboard.pages.dev`. The Functions in
`functions/` and the D1 binding from `wrangler.toml` are wired up automatically — no extra config.

At this point the site is **public**. Do step 6 before sharing the URL anywhere.

## 6. 🧍 HER — gate it privately with Cloudflare Access (free)

This is the important privacy step and it must be done in your Cloudflare dashboard.

1. Go to **[one.dash.cloudflare.com](https://one.dash.cloudflare.com/)** (Cloudflare **Zero Trust**).
   First time only: pick a team name and choose the **Free** plan (no card needed for up to 50 users).
2. **Access → Applications → Add an application → Self-hosted.**
3. **Application name:** `career-ops dashboard`.
4. **Session duration:** your choice (e.g. 24 hours).
5. Under **Public hostname**, enter the Pages domain from step 5:
   - Subdomain: `career-ops-dashboard`
   - Domain: pick `pages.dev` (or your custom domain if you added one).
   - (Path left blank = the whole site is protected, API included.)
6. **Next** to policies. Add one policy:
   - **Policy name:** `Only me`
   - **Action:** `Allow`
   - **Include → Emails →** `you@example.com` (add any others you want to allow).
7. **Next → Add application.**

Now every visit to the `*.pages.dev` URL (and every `/api/*` call) requires a one-time email
login code. Only allow-listed emails get in. This protects the API too, so no other auth is needed.

> **Defense-in-depth (optional):** Access injects a signed `Cf-Access-Jwt-Assertion` header on every
> allowed request. The Functions note where to verify that JWT in-app if you ever want belt-and-suspenders
> (see the comment block at the top of `functions/api/jobs.js`). Edge Access is the primary gate.

## 7. 🤖 Load your data (anytime the tracker changes)

```bash
node sync-applications-to-d1.mjs                                            # writes import.sql
npx wrangler d1 execute career-ops-dashboard --remote --file=import.sql     # applies it
```

`sync-applications-to-d1.mjs` reads `../data/applications.md`, enriches each row from its matching
`../reports/{num}-*.md` **Machine Summary** (url, location, verdict, strengths, gaps), and writes an
**idempotent** `import.sql` (`INSERT ... ON CONFLICT(id) DO UPDATE`). Re-running never duplicates.

> **The tracker is empty right now, so this emits 0 rows — that's expected.** Run it again after
> evaluations land and rows will flow in.

> **Re-sync is non-destructive to your edits:** the `ON CONFLICT` update refreshes evaluation-derived
> fields (score, verdict, strengths, gaps, links, …) but **preserves the `status` and `notes` you edit
> in the dashboard** on rows that already exist. (New rows still get status/notes seeded on first
> insert.) Change this in `PRESERVE_ON_CONFLICT` at the top of the sync script if you want different
> behavior.

npm-script shortcuts (equivalent to the above): `npm run sync`, `npm run import:remote`,
`npm run schema:remote`, `npm run deploy`.

---

## Local preview (before deploying)

You can see the real dashboard on your machine with a local D1 — no deploy, no Access:

```bash
# one time: create the local table
npx wrangler d1 execute career-ops-dashboard --local --file=schema.sql

# (optional) load local data
node sync-applications-to-d1.mjs
npx wrangler d1 execute career-ops-dashboard --local --file=import.sql

# serve public/ + functions/ with the local D1 bound as env.DB
npx wrangler pages dev public
```

Open the URL it prints (usually `http://localhost:8788`). `wrangler pages dev` reads the D1 binding
from `wrangler.toml` and persists local data under `.wrangler/` (gitignored). With an empty database
you'll see the graceful empty state: *"No jobs yet — evaluations will appear here."*

---

## API reference

All endpoints are same-origin JSON. Statuses are validated against the canonical set in
`../templates/states.yml` (Evaluated, Applied, Responded, Interview, Offer, Rejected, Discarded, SKIP).

| Method | Path            | Body                                   | Returns |
|--------|-----------------|----------------------------------------|---------|
| GET    | `/api/jobs`     | —                                      | `[job, …]` newest id first |
| POST   | `/api/jobs`     | `{company, role, score?, status?, …}`  | `201` created job (auto id = max+1) |
| GET    | `/api/jobs/:id` | —                                      | one job / `404` |
| PATCH  | `/api/jobs/:id` | any editable fields, e.g. `{status}`   | updated job (bumps `updated_at`) |
| DELETE | `/api/jobs/:id` | —                                      | `{ok:true,id}` / `404` |

Every query is parameterized (`.prepare(sql).bind(...)`) — no string-concatenated SQL.

---

## Customizing

- **Colors / type:** `public/styles.css` — raw palette tokens are on `:root`; components use semantic
  tokens layered on top, so the `prefers-color-scheme: dark` variant only remaps roles.
- **Statuses:** keep `STATUSES` in `public/app.js`, the `CANONICAL_STATUSES` set in both Functions, and
  `../templates/states.yml` in sync (states.yml is the source of truth).
- **Extra columns:** add to `schema.sql`, the `COLUMNS` list in the sync script, and the render in
  `app.js`.
