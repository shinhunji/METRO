# Metro TAGO proxy

This Cloudflare Worker keeps the TAGO service key outside the GitHub Pages frontend.

## Environment variables

For local development, copy `.dev.vars.example` to `.dev.vars`, then add your newly issued TAGO key:

```powershell
Copy-Item .dev.vars.example .dev.vars
npx wrangler dev
```

`.dev.vars` and `.env` are ignored by Git and must never be committed.

For Cloudflare production, the key must be a Worker Secret. GitHub Pages cannot securely use a `.env` file at runtime.

## One-time deployment

1. Sign in to Cloudflare from this folder: `npx wrangler login`
2. Update `ALLOWED_ORIGIN` in `wrangler.toml` if the GitHub Pages origin differs.
3. Deploy the Worker: `npx wrangler deploy`
4. Set the production secret with the following command. Paste the newly issued TAGO key only into the terminal prompt:
   `npx wrangler secret put TAGO_SERVICE_KEY`
5. Copy the Worker URL printed by deployment into `프로젝트/api-config.js` as `window.METRO_API_BASE`.

`api-config.js` is intentionally public because it contains only the Worker URL. Do not put the TAGO key in it.
