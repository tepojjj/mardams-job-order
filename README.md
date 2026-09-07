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
  Super Admin accounts, and cannot see the Analytics tab. On the
  **Attendance** tab, Admins see the full company-wide attendance
  report (not just their own punches) and can manually add or edit
  any employee's attendance times — the same as Super Admin, except
  Admins cannot delete an attendance record.
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
  **Attendance** tab. Admin and Super Admin additionally see the
  full attendance report for every employee there and can use
  **+ Add Manual Entry** to record punches an employee missed (or
  fix existing ones) for any employee and date — Staff only ever see
  their own punches. The **Payroll** tab (holiday calendar, pay
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

## Attendance geofencing & the office QR code

Attendance punches (clock in/out from the Attendance tab) are checked
against the office's GPS coordinates:

- `OFFICE_LAT`, `OFFICE_LNG` — the office's coordinates. Default to
  Mardam Sign Ads' actual pin (10.3481995, 123.9297401) if not set.
- `OFFICE_RADIUS_M` — how far from that point still counts as "at the
  office," in meters. Defaults to `200`.

A punch made outside that radius — or with no location available at
all (permission denied, GPS unavailable) — is still recorded, but is
flagged **"Off-site"** in the Attendance Report for Admin/Super Admin
to review. It never blocks the employee from clocking in.

Admin and Super Admin see a printable **Office Attendance QR Code**
panel at the top of the Attendance tab. It's a static code — no need
to regenerate it — that links to this app with `?clock=1`, which opens
straight to the clock-in screen after login. Print it and post it at
the entrance; scanning it from off-site still works (the QR itself
carries no location data), but the GPS check on the punch itself is
what catches that and marks it Off-site.

Attendance entries added or edited manually by an Admin/Super Admin
(see below) never carry a GPS flag — that badge only ever applies to
a live clock-in/out punch.

## Material List, Inventory, Purchase History & Stock In/Out

Four tabs, alongside the Monitoring Sheet, work together to track
materials:

- **Material List** — the master list: Material, Supplier, Brand, Unit.
  Add/edit/delete rows inline, same as the Monitoring Sheet. Every other
  tab below references a row here by id, so editing a material's
  Supplier or Unit here updates it everywhere.
- **Inventory** — a *computed* stock view, not its own data entry form:
  Material, Supplier, Unit, Current Stock. The first three columns come
  straight from Material List; Current Stock is the running total of
  that material's Stock In/Out ledger (see below). It turns red at zero
  or below. There's nothing to type here.
- **Purchase History** — a purchase log: Date, PO No., DR No., Supplier,
  Material, Unit, Qty, Price, Amount (computed as Qty × Price), Prepared
  By, Memo. The Material field autocompletes against Material List as
  you type, to avoid encoding the same material twice under slightly
  different names. Saving a row finds-or-creates the matching Material
  List entry and keeps one Stock In row in sync on the ledger — editing
  a purchase's Qty or Material later updates that same ledger row rather
  than double-counting, and deleting the purchase removes it too.
- **Stock In/Out** — the movement ledger Inventory's Current Stock is
  computed from. Rows tagged "(Purchase)" are the auto-generated ones
  from Purchase History and can only be changed there. Everything else
  is typed in by hand — mainly **Stock Out**, logged by whoever uses a
  material (Material, Qty, Reference, Personnel, Notes), plus a manual
  **Stock In** option for corrections.

All four tabs are visible to every logged-in Apparel account (Staff,
Admin, Super Admin), and any of them can add, edit, or delete rows —
same access rule as the Monitoring Sheet.

## Files

- `index.html` — the form, login screen, Monitoring Sheet, Material
  List, Inventory, Purchase History, Stock In/Out, and Users tab
- `api/counter.js` — tracks the running job-order number (login required)
- `api/orders.js` — saves/lists job orders (login required), deletes job
  orders (Super Admin only)
- `api/monitor.js` — saves/lists/deletes Monitoring Sheet rows (login
  required)
- `api/materials.js` — saves/lists/deletes both Material List rows
  (`?resource=materials`, the default) and Stock In/Out ledger rows
  (`?resource=stock`); login required. Combined into one file so this
  stays a single serverless function — Vercel's Hobby plan caps a
  deployment at 12, and this project is already at that limit
- `api/purchases.js` — saves/lists/deletes Purchase History rows (login
  required)
- `api/attendance.js` — clock in/out (any logged-in account, own record
  only); full attendance report and manual add/edit of any employee's
  attendance (Admin & Super Admin); delete a record (Super Admin only)
- `api/users.js` — lists/creates/deletes accounts (Admin & Super Admin)
- `api/login.js` — verifies login and issues a session token; also
  bootstraps the first Super Admin account (see above)
- `api/_auth.js` — shared password hashing + session token helpers
- `package.json` — declares the `@vercel/kv` dependency

No `vercel.json` is required — Vercel automatically serves `index.html` as
a static file and treats anything in `/api` as a serverless function
reachable at `/api/<filename>`.
