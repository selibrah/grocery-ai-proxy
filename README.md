# grocery-ai-proxy

AI proxy for the Grocery Price Tracker app: holds the Groq/NVIDIA keys so the app never does.
`ai-proxy.mjs` is copied from `server/` in the app repo; change it there and copy it here.

- Vercel: `api/ai/[task].mjs` serves `POST /api/ai/:task`.
- Local: `node --env-file=.env ai-proxy.mjs` serves `POST /ai/:task` on port 8787.

Env: `GROQ_API_KEY`, `NVIDIA_API_KEY`, `AI_ACCESS_TOKEN` (the app sends it as `x-app-token`).
Optional: `AI_DAILY_LIMIT` (per device, 30), `AI_IP_DAILY_LIMIT` (per IP, 150).

## Admin

`/admin` shows calls, tokens, devices and each key's Groq quota, and lets you add/remove keys
and change the limits. Needs `ADMIN_TOKEN` and an Upstash Redis store
(`vercel integration add upstash/upstash-kv`, which sets `KV_REST_API_URL`/`KV_REST_API_TOKEN`).
Without Redis the proxy still works, with in-memory limits and no stats.
