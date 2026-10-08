// Local AI proxy: holds the API keys so the app never does.
// Picks a model per task, falls back Groq -> NVIDIA on 429/5xx, caps requests per device.
// Run: yarn ai-proxy   (reads .env)
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const GROQ = { url: 'https://api.groq.com/openai/v1/chat/completions', key: process.env.GROQ_API_KEY };
const NVIDIA = { url: 'https://integrate.api.nvidia.com/v1/chat/completions', key: process.env.NVIDIA_API_KEY };

// Attempts in order. NVIDIA free tier is dev/beta only (see docs/design/stitch/REPORT.md §8.6).
export const ROUTES = {
  draft: [[GROQ, 'openai/gpt-oss-20b'], [NVIDIA, 'openai/gpt-oss-20b']],
  chat: [[GROQ, 'openai/gpt-oss-120b'], [NVIDIA, 'openai/gpt-oss-20b']],
  receipt: [[GROQ, 'qwen/qwen3.8-27b']],
};

export async function complete(task, body, fetchImpl = fetch) {
  const routes = ROUTES[task];
  if (!routes) return { status: 400, json: { error: `unknown task: ${task}` } };
  let last;
  for (const [provider, model] of routes) {
    try {
      const res = await fetchImpl(provider.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.key}` },
        body: JSON.stringify({ ...body, model, stream: false }),
      });
      last = { status: res.status, json: await res.json() };
      if (res.status !== 429 && res.status < 500) return last;
    } catch (e) {
      last = { status: 502, json: { error: String(e) } };
    }
  }
  return last;
}

const WHISPER_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
// Biases spelling toward how Moroccans say prices; Whisper treats it as preceding text.
const WHISPER_PROMPT = 'lait 7 dh Marjane, sokkar 9 drahm f BIM, حليب سنطرال 7 دراهم, زيت لوسيور 24 درهم, huile Lesieur 24,50.';

// Audio arrives as the raw request body; Groq wants multipart.
export async function transcribe(audio, mime, fetchImpl = fetch) {
  let last;
  for (const model of ['whisper-large-v3-turbo', 'whisper-large-v3']) {
    const form = new FormData();
    form.append('file', new Blob([audio], { type: mime }), `audio.${mime.split('/')[1]?.split(';')[0] || 'm4a'}`);
    form.append('model', model);
    form.append('prompt', WHISPER_PROMPT);
    form.append('response_format', 'json');
    try {
      const res = await fetchImpl(WHISPER_URL, { method: 'POST', headers: { Authorization: `Bearer ${GROQ.key}` }, body: form });
      last = { status: res.status, json: await res.json() };
      if (res.status !== 429 && res.status < 500) return last;
    } catch (e) {
      last = { status: 502, json: { error: String(e) } };
    }
  }
  return last;
}

export const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT ?? 30);
// Device ids are made up by the client, so a deployed proxy also caps each IP.
export const IP_DAILY_LIMIT = Number(process.env.AI_IP_DAILY_LIMIT ?? 150);
const MAX_BODY = 25 * 1024 * 1024; // receipt images (base64) and voice clips
// ponytail: in-memory counter, resets on restart; use KV/DB once deployed
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
  if (!GROQ.key || !NVIDIA.key) throw new Error('GROQ_API_KEY and NVIDIA_API_KEY must be set in .env');
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '127.0.0.1'; // HOST=0.0.0.0 when deployed, or for a phone on your Wi-Fi
  server.listen(port, host, () => console.log(`AI proxy on http://${host}:${port}`));
}
