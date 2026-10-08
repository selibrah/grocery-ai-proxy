// Shared state for the deployed proxy: limits, extra API keys, usage stats.
// Upstash Redis over its REST API (the Vercel Marketplace integration sets these vars).
// Unset (local dev) = memory limits, env keys only, no stats.
import { DAILY_LIMIT, IP_DAILY_LIMIT, envKeys, overLimit } from './ai-proxy.mjs';

const URL_ = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
export const hasStore = Boolean(URL_ && TOKEN);

const DAY = 86400;
export const day = (d = new Date()) => d.toISOString().slice(0, 10);

// Several commands, one round trip.
export async function redis(cmds) {
  const res = await fetch(`${URL_}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(cmds),
  });
  if (!res.ok) throw new Error(`redis ${res.status}`);
  return (await res.json()).map((r) => r.result);
}

// Redis returns hashes as [field, value, field, value, ...].
export const hash = (flat) => Object.fromEntries((flat ?? []).flatMap((v, i, a) => (i % 2 ? [] : [[v, a[i + 1]]])));

export async function limits() {
  if (!hasStore) return { daily: DAILY_LIMIT, ip: IP_DAILY_LIMIT };
  const [c] = await redis([['HGETALL', 'config']]);
  const h = hash(c);
  return { daily: Number(h.daily ?? DAILY_LIMIT), ip: Number(h.ip ?? IP_DAILY_LIMIT) };
}

/** Counts this call against the device and IP; true once either is over today's limit. */
export async function overLimits(device, ip) {
  if (!hasStore) return overLimit(`ip:${ip}`, IP_DAILY_LIMIT) || overLimit(device, DAILY_LIMIT);
  const d = `lim:${day()}:${device}`;
  const i = `lim:${day()}:ip:${ip}`;
  const [nd, , ni, , c] = await redis([['INCR', d], ['EXPIRE', d, 2 * DAY], ['INCR', i], ['EXPIRE', i, 2 * DAY], ['HGETALL', 'config']]);
  const h = hash(c);
  return nd > Number(h.daily ?? DAILY_LIMIT) || ni > Number(h.ip ?? IP_DAILY_LIMIT);
}

// ponytail: keys added from the admin sit in Redis as plain text (Upstash encrypts at rest);
// encrypt with ADMIN_TOKEN if the database is ever shared.
export async function keys() {
  const all = envKeys();
  if (!hasStore) return all;
  const [flat] = await redis([['HGETALL', 'keys']]);
  for (const [id, raw] of Object.entries(hash(flat))) {
    const k = JSON.parse(raw);
    if (all[k.provider]) all[k.provider].push({ id, key: k.key });
  }
  return all;
}

export async function record(task, status, attempts, device) {
  if (!hasStore) return;
  const s = `stats:${day()}`;
  const dv = `devices:${day()}`;
  const cmds = [['HINCRBY', s, 'req', 1], ['HINCRBY', s, `task:${task}`, 1], ['PFADD', dv, device], ['EXPIRE', s, 90 * DAY], ['EXPIRE', dv, 90 * DAY]];
  if (status === 'blocked') cmds.push(['HINCRBY', s, 'blocked', 1]);
  else if (status >= 400) cmds.push(['HINCRBY', s, 'fail', 1]);
  for (const a of attempts) {
    cmds.push(
      ['HINCRBY', s, 'tok', a.tokens],
      ['HINCRBY', s, `key:${a.keyId}:req`, 1],
      ['HINCRBY', s, `key:${a.keyId}:tok`, a.tokens],
      ['HINCRBY', s, `model:${a.model}:req`, 1],
      ['HINCRBY', s, `model:${a.model}:tok`, a.tokens]
    );
    if (a.status >= 400) cmds.push(['HINCRBY', s, `key:${a.keyId}:err`, 1]);
    if (a.limits) cmds.push(['HSET', 'ratelimits', `${a.keyId}|${a.model}`, JSON.stringify({ ...a.limits, at: Date.now() })]);
  }
  const log = { at: Date.now(), task, status, tries: attempts.map(({ keyId, model, status, tokens, ms }) => ({ keyId, model, status, tokens, ms })) };
  cmds.push(['LPUSH', 'log', JSON.stringify(log)], ['LTRIM', 'log', 0, 99]);
  await redis(cmds).catch(() => {}); // stats must never break a request
}
