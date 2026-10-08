import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorized, complete, transcribe } from './ai-proxy.mjs';

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

test('does not retry on a 400 from Groq', async () => {
  let n = 0;
  const out = await complete('chat', { messages: [] }, async () => (n++, reply(400)), KEYS);
  assert.equal(out.status, 400);
  assert.equal(n, 1);
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
