# EnviShield

## Worker auto-deploy
The proxy code lives in `worker/`. Pushing a change to `worker/` on `main` deploys it to Cloudflare through
`.github/workflows/deploy-worker.yml`. It needs two repository secrets (Settings, Secrets and variables, Actions):
`CLOUDFLARE_API_TOKEN` (token from the "Edit Cloudflare Workers" template) and `CLOUDFLARE_ACCOUNT_ID`.
The Worker's own secrets (Ambient, AccuWeather, data.gov.in keys) stay in Cloudflare and are not changed by a deploy.
