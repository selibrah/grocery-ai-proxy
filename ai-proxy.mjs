// Local AI proxy: holds the API keys so the app never does.
// Picks a model per task, falls back Groq -> NVIDIA on 429/5xx, caps requests per device.
// Run: yarn ai-proxy   (reads .env)
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PROVIDERS = {
  groq: { url: 'https://api.groq.com/openai/v1/chat/completions', env: 'GROQ_API_KEY' },
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/chat/completions', env: 'NVIDIA_API_KEY' },
};

/** Keys from the environment; the deployed proxy adds the ones saved from the admin page. */
export function envKeys() {
  return Object.fromEntries(
    Object.entries(PROVIDERS).map(([name, p]) => [name, process.env[p.env] ? [{ id: `${name}-env`, key: process.env[p.env] }] : []])
  );
}

// Attempts in order. NVIDIA free tier is dev/beta only (see docs/design/stitch/REPORT.md §8.6).
export const ROUTES = {
  draft: [['groq', 'openai/gpt-oss-20b'], ['nvidia', 'openai/gpt-oss-20b']],
  chat: [['groq', 'openai/gpt-oss-120b'], ['nvidia', 'openai/gpt-oss-20b']],
  receipt: [['groq', 'qwen/qwen3.8-27b']],
};

// Groq reports what is left of each key's quota on every response.
const LIMIT_HEADERS = ['limit-requests', 'remaining-requests', 'reset-requests', 'limit-tokens', 'remaining-tokens', 'reset-tokens'];
const readLimits = (res) => {
  const out = Object.fromEntries(LIMIT_HEADERS.flatMap((h) => (res.headers?.get?.(`x-ratelimit-${h}`) ? [[h, res.headers.get(`x-ratelimit-${h}`)]] : [])));
  return Object.keys(out).length ? out : undefined;
};

// Every key of a provider gets a turn before moving on: a 429 means that key is spent, a
// 401/403 means it was revoked. Returns the reply plus one entry per try, for the stats.
async function attempt(tries, keys, send, fetchImpl) {
  const attempts = [];
  let last = { status: 503, json: { error: 'no API key configured' } };
  for (const [provider, model] of tries) {
    for (const { id, key } of keys[provider] ?? []) {
      const t0 = Date.now();
      try {
        const res = await fetchImpl(...send(provider, model, key));
        last = { status: res.status, json: await res.json() };
        attempts.push({ provider, keyId: id, model, status: res.status, tokens: last.json?.usage?.total_tokens ?? 0, ms: Date.now() - t0, limits: readLimits(res) });
        if (![401, 403, 429].includes(res.status) && res.status < 500) return { ...last, attempts };
      } catch (e) {
        last = { status: 502, json: { error: String(e) } };
        attempts.push({ provider, keyId: id, model, status: 502, tokens: 0, ms: Date.now() - t0 });
      }
    }
  }
  return { ...last, attempts };
}

export function complete(task, body, fetchImpl = fetch, keys = envKeys()) {
  const routes = ROUTES[task];
  if (!routes) return Promise.resolve({ status: 400, json: { error: `unknown task: ${task}` }, attempts: [] });
  const send = (provider, model, key) => [
    PROVIDERS[provider].url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ ...body, model, stream: false }),
    },
  ];
  return attempt(routes, keys, send, fetchImpl);
}

const WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
// Biases spelling toward how Moroccans say prices; Whisper treats it as preceding text.
const WHISPER_PROMPT = 'lait 7 dh Marjane, sokkar 9 drahm f BIM, حليب سنطرال 7 دراهم, زيت لوسيور 24 درهم, huile Lesieur 24,50.';

// Audio arrives as the raw request body; Groq wants multipart.
export function transcribe(audio, mime, fetchImpl = fetch, keys = envKeys()) {
  const send = (_, model, key) => {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mime }), `audio.${mime.split('/')[1]?.split(';')[0] || 'm4a'}`);
    form.append('model', model);
    form.append('prompt', WHISPER_PROMPT);
    form.append('response_format', 'json');
    return [WHISPER_URL, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form }];
  };
  return attempt([['groq', 'whisper-large-v3-turbo'], ['groq', 'whisper-large-v3']], keys, send, fetchImpl);
}

export const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT ?? 30);
// Device ids are made up by the client, so a deployed proxy also caps each IP.
export const IP_DAILY_LIMIT = Number(process.env.AI_IP_DAILY_LIMIT ?? 150);
const MAX_BODY = 25 * 1024 * 1024; // receipt images (base64) and voice clips
// ponytail: in-memory counter for local dev; the deployed proxy counts in Redis (store.mjs)
const used = new Map();

export function overLimit(key, limit) {
  const k = `${new Date().toISOString().slice(0, 10)}:${key}`;
  const n = (used.get(k) ?? 0) + 1;
  used.set(k, n);
  return n > limit;
}

// Once deployed the URL is public: only builds carrying AI_ACCESS_TOKEN may spend the keys.
// ponytail: the token ships inside the app, so it stops strangers, not someone who unpacks
// the APK; per-user sign-in if the app goes public. Unset (local dev) = open.
export function authorized(header, token = process.env.AI_ACCESS_TOKEN) {
  if (!token) return true;
  const a = Buffer.from(String(header ?? ''));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ponytail: the hosting platform appends the caller's IP last; trust only that entry.
const clientIp = (req) => String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',').at(-1).trim();

function send(res, status, json) {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(json));
}

const server = http.createServer(async (req, res) => {
  // Native apps send no Origin; allow only the local web build (expo start --web).
  const origin = req.headers.origin;
  if (origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-device-id, x-app-token');
  }
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  const task = req.method === 'POST' && req.url.match(/^\/ai\/(\w+)$/)?.[1];
  if (!task) return send(res, 404, { error: 'POST /ai/:task' });
  if (!authorized(req.headers['x-app-token'])) return send(res, 401, { error: 'unauthorized' });
  const device = req.headers['x-device-id'];
  if (!device) return send(res, 400, { error: 'x-device-id header required' });
  if (overLimit(`ip:${clientIp(req)}`, IP_DAILY_LIMIT) || overLimit(device, DAILY_LIMIT)) {
    return send(res, 429, { error: 'daily limit reached' });
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return send(res, 413, { error: 'body too large' });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  if (task === 'transcribe') {
    const out = await transcribe(raw, req.headers['content-type'] || 'audio/m4a');
    return send(res, out.status, out.json);
  }
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return send(res, 400, { error: 'invalid JSON' });
  }
  const out = await complete(task, body);
  send(res, out.status, out.json);
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.env.GROQ_API_KEY || !process.env.NVIDIA_API_KEY) throw new Error('GROQ_API_KEY and NVIDIA_API_KEY must be set in .env');
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1'; // HOST=0.0.0.0 when deployed, or for a phone on your Wi-Fi
  server.listen(port, host, () => console.log(`AI proxy on http://${host}:${port}`));
}
