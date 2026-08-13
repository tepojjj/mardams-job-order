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

The whole tool is now behind a login screen, with three account types:

- **Super Admin** — the one built-in top account. Can do everything,
  including **deleting** job orders on the Browse tab, and can create or
  remove both Admin and Staff accounts.
- **Admin** — can use the form and Browse tab like normal, and has a
  **Users** tab where they can create and remove **Staff** accounts
  (limited access). Admins cannot delete job orders, cannot create other
  Admins, and cannot see/remove other Admin or Super Admin accounts.
- **Staff** — can create and browse job orders, but has no Users tab and
  no delete button anywhere.

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

## Files

- `index.html` — the form, login screen, and Users tab
- `api/counter.js` — tracks the running job-order number (login required)
- `api/orders.js` — saves/lists job orders (login required), deletes job
  orders (Super Admin only)
- `api/users.js` — lists/creates/deletes accounts (Admin & Super Admin)
- `api/login.js` — verifies login and issues a session token; also
  bootstraps the first Super Admin account (see above)
- `api/_auth.js` — shared password hashing + session token helpers
- `package.json` — declares the `@vercel/kv` dependency

No `vercel.json` is required — Vercel automatically serves `index.html` as
a static file and treats anything in `/api` as a serverless function
reachable at `/api/<filename>`.
