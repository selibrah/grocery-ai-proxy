import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authorized, complete, transcribe } from './ai-proxy.mjs';

const reply = (status) => ({ status, json: async () => ({ status }) });

test('falls back to NVIDIA when Groq returns 429', async () => {
  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push([url, JSON.parse(init.body).model]);
    return reply(calls.length === 1 ? 429 : 200);
  };
  const out = await complete('draft', { messages: [] }, fakeFetch);
  assert.equal(out.status, 200);
  assert.match(calls[0][0], /groq/);
  assert.match(calls[1][0], /nvidia/);
});

test('does not retry on a 400 from Groq', async () => {
  let n = 0;
  const out = await complete('chat', { messages: [] }, async () => (n++, reply(400)));
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
  });
  assert.equal(out.status, 200);
  assert.deepEqual(models, ['whisper-large-v3-turbo', 'whisper-large-v3']);
});

test('requires the app token only when one is configured', () => {
  assert.equal(authorized(undefined, undefined), true);
  assert.equal(authorized('s3cret', 's3cret'), true);
  assert.equal(authorized('wrong!', 's3cret'), false);
  assert.equal(authorized(undefined, 's3cret'), false);
});
