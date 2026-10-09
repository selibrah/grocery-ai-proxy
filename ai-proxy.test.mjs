import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { authorized, complete, server, transcribe } from './ai-proxy.mjs';

const reply = (status) => ({ status, json: async () => ({ status }) });
const KEYS = { groq: [{ id: 'g1', key: 'a' }], nvidia: [{ id: 'n1', key: 'b' }] };

test('falls back to NVIDIA when Groq returns 429', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push([url, JSON.parse(init.body).model]);
    return reply(calls.length === 1 ? 429 : 200);
  };
  const out = await complete('draft', { messages: [] }, fakeFetch, KEYS);
  assert.equal(out.status, 200);
  assert.match(calls[0][0], /groq/);
  assert.match(calls[1][0], /nvidia/);
});

test('skips NVIDIA when NVIDIA_API_KEY is unset', async () => {
  const urls = [];
  const out = await complete('chat', { messages: [] }, async (url) => (urls.push(url), reply(429)), { groq: [{ id: 'g1', key: 'a' }], nvidia: [] });
  assert.equal(out.status, 429);
  assert.ok(urls.length > 0 && urls.every((u) => /groq/.test(u)));
});

test('does not retry on a 400 from Groq', async () => {
  let n = 0;
  const out = await complete('chat', { messages: [] }, async () => (n++, reply(400)), KEYS);
  assert.equal(out.status, 400);
  assert.equal(n, 1);
});

test('forwards only the fields the app uses and caps max_tokens', async () => {
  let sent;
  const fn = { type: 'function', function: { name: 'search_products', parameters: { type: 'object' } } };
  await complete(
    'chat',
    { messages: [], tools: [fn, { type: 'browser_search' }, { type: 'code_interpreter' }], max_tokens: 1e6, n: 8, service_tier: 'flex', model: 'other', stream: true },
    async (url, init) => ((sent = JSON.parse(init.body)), reply(200)),
    KEYS
  );
  assert.deepEqual(Object.keys(sent).sort(), ['max_tokens', 'messages', 'model', 'stream', 'tools']);
  assert.deepEqual(sent.tools, [fn]); // Groq's built-in tools are not offered
  assert.equal(sent.max_tokens, 8000);
  assert.equal(sent.model, 'openai/gpt-oss-120b');
  assert.equal(sent.stream, false);
  await complete('chat', { messages: [], max_tokens: 2000 }, async (url, init) => ((sent = JSON.parse(init.body)), reply(200)), KEYS);
  assert.equal(sent.max_tokens, 2000);
});

test('rejects unknown tasks', async () => {
  assert.equal((await complete('nope', {})).status, 400);
});

test('sends audio to Whisper as multipart and falls back to the larger model', async () => {
  const models = [];
  const out = await transcribe(Buffer.from('abc'), 'audio/webm', async (url, init) => {
    assert.match(url, /audio\/transcriptions/);
    assert.equal((await init.body.get('file').text()), 'abc');
    models.push(init.body.get('model'));
    return reply(models.length === 1 ? 503 : 200);
  }, KEYS);
  assert.equal(out.status, 200);
  assert.deepEqual(models, ['whisper-large-v3-turbo', 'whisper-large-v3']);
});

test('requires the app token only when one is configured', () => {
  assert.equal(authorized(undefined, undefined), true);
  assert.equal(authorized('s3cret', 's3cret'), true);
  assert.equal(authorized('wrong!', 's3cret'), false);
  assert.equal(authorized(undefined, 's3cret'), false);
});

test('tries every key of a provider before falling back, and reports each try', async () => {
  const keys = { groq: [{ id: 'g1', key: 'spent' }, { id: 'g2', key: 'revoked' }, { id: 'g3', key: 'ok' }], nvidia: [] };
  const out = await complete('draft', {}, async (_, init) => {
    const key = init.headers.Authorization.split(' ')[1];
    return {
      status: { spent: 429, revoked: 401, ok: 200 }[key],
      headers: new Headers(key === 'ok' ? { 'x-ratelimit-remaining-requests': '13' } : {}),
      json: async () => ({ usage: { total_tokens: 42 } }),
    };
  }, keys);
  assert.equal(out.status, 200);
  assert.deepEqual(out.attempts.map((a) => [a.keyId, a.status, a.tokens]), [['g1', 429, 42], ['g2', 401, 42], ['g3', 200, 42]]);
  assert.deepEqual(out.attempts[2].limits, { 'remaining-requests': '13' });
  assert.equal((await complete('draft', {}, fetch, { groq: [], nvidia: [] })).status, 503);
});

test('passes an unparseable JSON reply up the ladder, signing tool calls for Gemini', async () => {
  const sent = [];
  const keys = { groq: [{ id: 'g1', key: 'a' }], gemini: [{ id: 'm1', key: 'c' }], nvidia: [] };
  const body = {
    response_format: { type: 'json_object' },
    messages: [{ role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }],
  };
  const out = await complete('plan', body, async (url, init) => {
    sent.push([url, JSON.parse(init.body)]);
    const content = sent.length === 1 ? '{"days": [' : '{"days": []}'; // the first is cut off
    return { status: 200, ok: true, json: async () => ({ choices: [{ message: { content } }] }) };
  }, keys);
  assert.equal(out.status, 200);
  assert.deepEqual(out.attempts.map((a) => [a.keyId, a.status]), [['m1', 422], ['g1', 200]]);
  assert.match(sent[0][0], /generativelanguage/);
  assert.equal(sent[0][1].messages[0].tool_calls[0].extra_content.google.thought_signature, 'skip_thought_signature_validator');
  assert.equal(sent[1][1].messages[0].tool_calls[0].extra_content, undefined); // Groq gets the app's calls as they are
});

test('survives a client that aborts mid-upload', async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => {
        socket.write('POST /ai/chat HTTP/1.1\r\nHost: x\r\nx-device-id: abort-test\r\n');
        socket.write('Content-Type: application/json\r\nContent-Length: 100000\r\n\r\n{"messages":');
        setTimeout(() => (socket.destroy(), resolve()), 50);
      });
      socket.on('error', reject);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 404); // still serving
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
