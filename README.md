# grocery-ai-proxy

AI proxy for the Grocery Price Tracker app: holds the Groq/Gemini/NVIDIA keys so the app never does.
`ai-proxy.mjs` is copied from `server/` in the app repo; change it there and copy it here.

- Vercel: `api/ai/[task].mjs` serves `POST /api/ai/:task`.
- Local: `node --env-file=.env ai-proxy.mjs` serves `POST /ai/:task` on port 8787.

Env: `GROQ_API_KEY`, `GEMINI_API_KEY`, `NVIDIA_API_KEY`, `AI_ACCESS_TOKEN` (the app sends it as `x-app-token`).
Optional: `AI_DAILY_LIMIT` (per device, 30), `AI_IP_DAILY_LIMIT` (per IP, 150).

Each task walks a ladder of free models (`ROUTES` in `ai-proxy.mjs`): `chat` starts on Groq,
`plan` (recipes, meal plan) and `receipt` (photos) on Gemini, NVIDIA last. A JSON reply that
doesn't parse moves up the ladder too. Keep the Gemini key on an AI Studio project without
billing and it can only ever use the free tier (a spent quota is a 429, which falls through).

## Admin

`/admin` shows calls, tokens, devices and each key's Groq quota, and lets you add/remove keys
and change the limits. Needs `ADMIN_TOKEN` and an Upstash Redis store
(`vercel integration add upstash/upstash-kv`, which sets `KV_REST_API_URL`/`KV_REST_API_TOKEN`).
Without Redis the proxy still works, with in-memory limits and no stats.
