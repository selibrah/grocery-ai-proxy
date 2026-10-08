// Admin API behind public/admin.html. Every call needs `Authorization: Bearer <ADMIN_TOKEN>`.
import { randomUUID } from 'node:crypto';
import { authorized, envKeys, PROVIDERS, ROUTES } from '../ai-proxy.mjs';
import { day, hash, hasStore, limits, redis } from '../store.mjs';

const json = (status, body) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const mask = (key) => `${key.slice(0, 4)}…${key.slice(-4)}`;

// Fails closed: no ADMIN_TOKEN configured means no admin at all.
const allowed = (request) =>
  Boolean(process.env.ADMIN_TOKEN) && authorized(request.headers.get('authorization')?.replace(/^Bearer /, ''), process.env.ADMIN_TOKEN);

export async function GET(request) {
  if (!allowed(request)) return json(401, { error: 'unauthorized' });
  if (!hasStore) return json(503, { error: 'Redis not connected (KV_REST_API_URL / KV_REST_API_TOKEN)' });
  const days = Array.from({ length: 30 }, (_, i) => day(new Date(Date.now() - i * 86400e3))).reverse();
  const out = await redis([
    ...days.map((d) => ['HGETALL', `stats:${d}`]),
    ...days.map((d) => ['PFCOUNT', `devices:${d}`]),
    ['HGETALL', 'keys'],
    ['HGETALL', 'ratelimits'],
    ['LRANGE', 'log', 0, 49],
  ]);
  const [flatKeys, flatRates, log] = out.slice(days.length * 2);
  const env = Object.entries(envKeys()).flatMap(([provider, list]) =>
    list.map((k) => ({ id: k.id, provider, label: `${PROVIDERS[provider].env} (Vercel env)`, masked: mask(k.key), source: 'env' }))
  );
  const added = Object.entries(hash(flatKeys)).map(([id, raw]) => {
    const k = JSON.parse(raw);
    return { id, provider: k.provider, label: k.label, masked: mask(k.key), source: 'admin', added: k.added };
  });
  return json(200, {
    limits: await limits(),
    days: days.map((date, i) => ({ date, devices: out[days.length + i] ?? 0, ...Object.fromEntries(Object.entries(hash(out[i])).map(([k, v]) => [k, Number(v)])) })),
    keys: [...env, ...added],
    rateLimits: Object.fromEntries(Object.entries(hash(flatRates)).map(([k, v]) => [k, JSON.parse(v)])),
    log: (log ?? []).map((l) => JSON.parse(l)),
  });
}

// A key counts as valid unless the provider says it is unknown (401/403); a 1-token call is enough.
async function check(provider, key) {
  const model = ROUTES.draft.find(([p]) => p === provider)[1];
  const res = await fetch(PROVIDERS[provider].url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
  });
  return ![401, 403].includes(res.status);
}

export async function POST(request) {
  if (!allowed(request)) return json(401, { error: 'unauthorized' });
  if (!hasStore) return json(503, { error: 'Redis not connected' });
  let b;
  try {
    b = await request.json();
  } catch {
    return json(400, { error: 'invalid JSON' });
  }
  if (b.action === 'addKey') {
    const key = String(b.key ?? '').trim();
    if (!PROVIDERS[b.provider] || key.length < 20) return json(400, { error: 'provider and key required' });
    if (!(await check(b.provider, key))) return json(400, { error: `${b.provider} rejected this key` });
    const id = `${b.provider}-${randomUUID().slice(0, 6)}`;
    const label = String(b.label ?? '').slice(0, 60) || id;
    await redis([['HSET', 'keys', id, JSON.stringify({ provider: b.provider, key, label, added: Date.now() })]]);
    return json(200, { id });
  }
  if (b.action === 'deleteKey') {
    await redis([['HDEL', 'keys', String(b.id)]]); // its old stats stay, labelled by id
    return json(200, { ok: true });
  }
  if (b.action === 'setLimits') {
    const daily = Math.floor(Number(b.daily));
    const ip = Math.floor(Number(b.ip));
    if (!(daily > 0 && ip > 0)) return json(400, { error: 'limits must be positive numbers' });
    await redis([['HSET', 'config', 'daily', daily, 'ip', ip]]);
    return json(200, { ok: true });
  }
  return json(400, { error: 'unknown action' });
}
