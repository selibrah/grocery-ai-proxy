// Vercel entry point: same checks as the local server in ai-proxy.mjs, as a Web-standard handler.
// ponytail: limits live in each function instance's memory, so cold starts reset them and
// instances don't share them; move the counter to Upstash/Vercel KV if strangers hammer it.
import { authorized, complete, overLimit, transcribe, DAILY_LIMIT, IP_DAILY_LIMIT } from '../../ai-proxy.mjs';

export const maxDuration = 60; // a week of dinners takes ~30 s

// Native apps send no Origin; allow only a local web build (expo start --web), as the local server does.
const cors = (request) => {
  const origin = request.headers.get('origin');
  return origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
    ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'content-type, x-device-id, x-app-token' }
    : {};
};

export const OPTIONS = (request) => new Response(null, { status: 204, headers: cors(request) });

export async function POST(request) {
  const json = (status, body) => Response.json(body, { status, headers: cors(request) });
  const task = new URL(request.url).pathname.split('/').pop();
  if (!authorized(request.headers.get('x-app-token'))) return json(401, { error: 'unauthorized' });
  const device = request.headers.get('x-device-id');
  if (!device) return json(400, { error: 'x-device-id header required' });
  // Vercel sets x-real-ip to the caller's address; clients can't spoof it.
  const ip = request.headers.get('x-real-ip') ?? 'unknown';
  if (overLimit(`ip:${ip}`, IP_DAILY_LIMIT) || overLimit(device, DAILY_LIMIT)) {
    return json(429, { error: 'daily limit reached' });
  }
  if (task === 'transcribe') {
    const audio = Buffer.from(await request.arrayBuffer());
    const out = await transcribe(audio, request.headers.get('content-type') || 'audio/m4a');
    return json(out.status, out.json);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'invalid JSON' });
  }
  const out = await complete(task, body);
  return json(out.status, out.json);
}
