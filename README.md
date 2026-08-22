# Mardams Apparel — Job Order Form

A single-page job order form with a shared, auto-incrementing order number
(backed by a Vercel Serverless Function + Vercel KV storage) and a
paste/upload reference photo section.

## Deploying to Vercel

Because this includes a backend function, it needs a **Git-based deploy**
or the **Vercel CLI**.

### Option A — Vercel CLI (fastest)

1. Install the CLI if you don't have it: `npm install -g vercel`
2. From this folder, run:
   ```
   vercel --prod
   ```
3. Follow the prompts to log in / create a project.

### Option B — Connect a Git repo

1. Push this folder to a new GitHub (or GitLab/Bitbucket) repo.
2. In the Vercel dashboard: **Add New... → Project**, import the repo.
3. Framework preset: choose **Other** (this is a static HTML site with an
   `/api` function, no build step needed). Click **Deploy**.

### Required: create a Vercel KV database

The order counter needs somewhere to persist server-side, shared across
every device. Vercel KV (a Redis store) fills the role that Netlify Blobs
played before.

1. In the Vercel dashboard, open your project → **Storage** tab.
2. Click **Create Database → KV**, give it a name (e.g. `job-orders`), and
   create it.
3. On the "Connect Project" step, link it to this project — Vercel will
   automatically add the `KV_REST_API_URL` and `KV_REST_API_TOKEN`
   (and related) environment variables for you. No manual `.env` setup
   needed.
4. Redeploy (or it will pick up the new env vars on the next deploy).

That's it — `/api/counter` will read/write to that KV store.

## How the counter works

- Opening the form calls `GET /api/counter` to **preview** the next number —
  nothing is saved yet.
- Clicking **Print / Save as PDF** calls `POST /api/counter` with the number
  actually on the form, saving it as the last-used number.
- **Reset Counter** clears the saved number so the next form starts back at
  `00000001`.
- The count is stored server-side (Vercel KV), so it's shared across
  every device/browser hitting the same deployed site — not per-browser.

## Font

The form now uses **Roboto** (loaded from Google Fonts) instead of the
original Courier New / Georgia mix.

## Login & accounts

The whole tool is now behind a login screen, with four account types:

- **Super Admin** — the one built-in top account. Can do everything,
  including **deleting** and **editing** job orders on the Browse tab,
  create or remove Admin, Accounting, and Staff accounts, and is the
  only role that can see the **Analytics** tab, the **Payroll** tab,
  and the full **Users / Account Log**.
- **Admin** — can use the form and Browse tab, and can **view and
  edit** existing job orders (but not delete them). Has a **Users**
  tab where they can create and remove **Staff** accounts (limited
  access). Admins cannot delete job orders, cannot create other
  Admins or Accounting accounts, cannot see/remove other Admin or
  Super Admin accounts, and cannot see the Analytics tab.
- **Staff** — view-only on job orders (no edit, no delete), has no
  Users tab, and cannot see Analytics.
- **Accounting** — doesn't use this app at all. Trying to log in here
  shows a message pointing to the **Attendance & Payroll** app
  instead (a separate deployment — see below). Only the Super Admin
  can create Accounting accounts, from this app's Users tab.

Every account also has a **Department** — **Apparel** or **Sign
Ads** — set when the account is created (not applicable to
Accounting accounts). **Sign Ads department accounts are blocked from
this app entirely**, the same as Accounting: logging in here shows
the "use the other app" message. This app is Apparel-only; Sign Ads
staff/admins log into a Sign Ads-specific tool instead (not included
here).

- **Everyone who *can* use this app** (Apparel Staff, Apparel Admin,
  Super Admin) can also clock themselves **in and out** from the
  **Attendance** tab. The **Payroll** tab (holiday calendar, pay
  generation, per-employee breakdown, and OT rate/allowance/deduction
  editing) is visible to the **Super Admin only**.

### Attendance & Payroll is also its own app

Accounting and Sign Ads accounts don't use Job Orders at all, so a
second deployment — **Mardams Attendance & Payroll** (a sibling
folder/project) — gives them somewhere to clock in/out and (for
Accounting) run payroll. Both apps share the same accounts, KV
database, and `AUTH_SECRET`, and both read/write the same underlying
attendance and payroll records — running payroll from either app
updates the same shared data, so nothing needs to be kept in sync.
See that app's README for its own setup.
### Required: set up the Super Admin

There's no sign-up page — the first Super Admin is created automatically
the first time someone logs in with credentials you set yourself:

1. In the Vercel dashboard, open your project → **Settings → Environment
   Variables** and add:
   - `SUPERADMIN_USERNAME` — the login username for the Super Admin
   - `SUPERADMIN_PASSWORD` — the login password for the Super Admin
   - `AUTH_SECRET` — any long random string (used to sign login sessions —
     e.g. generate one with `openssl rand -hex 32`)
2. Redeploy so the new env vars are picked up.
3. Open the site and log in once with the `SUPERADMIN_USERNAME` /
   `SUPERADMIN_PASSWORD` you set. That first successful login creates the
   real Super Admin account in the KV store (hashed password, not the raw
   env var). From then on, log in with that same username/password as
   normal — the env vars are only used for that one-time bootstrap.
4. From the **Users** tab, the Super Admin can then create Admin and
   Staff accounts with their own separate passwords.

Sessions last 12 hours; after that, logging in again is required.

## Google Sheets integration

The Monitoring Sheet can automatically mirror every add/edit/delete into a
Google Sheet, live — no manual copy/paste, no scheduled export. This is
**optional**; the app works exactly the same without it.

How it works: this app's own storage (Vercel KV) stays the source of
truth. Every time a Monitoring Sheet row changes, the browser calls
`/api/sheets-sync` (a Vercel function), which forwards that row to a
Google Apps Script Web App tied to your target spreadsheet, which writes
it in. If it's not set up, or Google is briefly unreachable, this fails
silently — it never blocks or slows down saving to the Monitoring Sheet
itself.

### Setup

1. Open (or create) the Google Sheet you want the data mirrored into.
2. **Extensions → Apps Script**, delete any placeholder code, and paste in
   the contents of `google-apps-script.gs` (included in this project).
3. In that pasted script, replace `SHARED_SECRET` with a long random
   string — e.g. generate one with `openssl rand -hex 24`.
4. **Deploy → New deployment → type: Web app.**
   - Execute as: **Me**
   - Who has access: **Anyone** (this has to be "Anyone" so Vercel can
     reach it — the shared secret is what actually protects your sheet
     from strangers, since nobody else will know it)
5. Copy the Web App URL it gives you (ends in `/exec`).
6. In the Vercel dashboard → your project → **Settings → Environment
   Variables**, add:
   - `GOOGLE_SHEETS_WEBHOOK_URL` — the URL from step 5
   - `GOOGLE_SHEETS_SECRET` — the same random string from step 3
7. Redeploy the Vercel project so it picks up the new env vars.

From then on, a tab named **"Monitoring Sheet"** is created automatically
in that spreadsheet (with headers) the first time a row syncs, and every
add/edit/delete in this app's Monitoring Sheet updates it within a couple
of seconds.

If you ever edit `google-apps-script.gs` later, use **Deploy → New
deployment** again (not just save) — otherwise the live URL keeps running
the old code.

## Inventory & Purchase History

Two more tabs, alongside the Monitoring Sheet, for tracking materials:

- **Inventory** — a stock list: Material, Unit, Current Stock, Reorder
  Level, Notes. Add/edit/delete rows inline, same as the Monitoring
  Sheet. A row's stock number turns red once it's at or below its
  Reorder Level. This is a manually-maintained count — it is **not**
  automatically adjusted by Purchase History or by job orders.
- **Purchase History** — a purchase log: Date, PO No., DR No.,
  Supplier, Material, Qty, Price, Amount (computed as Qty × Price),
  Prepared By, Memo — matching the columns of an existing paper/Excel
  purchase log. Supports search, CSV export, and a running total.

Both tabs are visible to every logged-in Apparel account (Staff,
Admin, Super Admin), and any of them can add, edit, or delete rows —
same access rule as the Monitoring Sheet. Since the two aren't wired
together, update Inventory's Current Stock by hand when you log a new
Purchase History row, if you want the two to match.

## Files

- `index.html` — the form, login screen, Monitoring Sheet, Inventory,
  Purchase History, and Users tab
- `api/counter.js` — tracks the running job-order number (login required)
- `api/orders.js` — saves/lists job orders (login required), deletes job
  orders (Super Admin only)
- `api/monitor.js` — saves/lists/deletes Monitoring Sheet rows (login
  required)
- `api/inventory.js` — saves/lists/deletes Inventory rows (login required)
- `api/purchases.js` — saves/lists/deletes Purchase History rows (login
  required)
- `api/sheets-sync.js` — forwards Monitoring Sheet changes to the Google
  Sheets webhook, if configured (see "Google Sheets integration" above)
- `api/users.js` — lists/creates/deletes accounts (Admin & Super Admin)
- `api/login.js` — verifies login and issues a session token; also
  bootstraps the first Super Admin account (see above)
- `api/_auth.js` — shared password hashing + session token helpers
- `google-apps-script.gs` — paste this into your Google Sheet's Apps
  Script editor to receive the synced data (see "Google Sheets
  integration" above)
- `package.json` — declares the `@vercel/kv` dependency

No `vercel.json` is required — Vercel automatically serves `index.html` as
a static file and treats anything in `/api` as a serverless function
reachable at `/api/<filename>`.
