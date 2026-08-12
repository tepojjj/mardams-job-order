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

## Files

- `index.html` — the form itself
- `api/counter.js` — the backend serverless function
- `package.json` — declares the `@vercel/kv` dependency

No `vercel.json` is required — Vercel automatically serves `index.html` as
a static file and treats anything in `/api` as a serverless function
reachable at `/api/<filename>`.
