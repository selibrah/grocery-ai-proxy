# grocery-ai-proxy

AI proxy for the Grocery Price Tracker app: holds the Groq/NVIDIA keys so the app never does.
Copied from `server/` in the app repo; change it there and copy it here.

Env: `GROQ_API_KEY`, `NVIDIA_API_KEY`, `AI_ACCESS_TOKEN` (the app sends it as `x-app-token`),
`HOST=0.0.0.0` when deployed. Optional: `AI_DAILY_LIMIT` (per device, 30), `AI_IP_DAILY_LIMIT` (150).
