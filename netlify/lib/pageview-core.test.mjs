import test from 'node:test';
import assert from 'node:assert/strict';
import { createPageviewHandler } from './pageview-core.mjs';

class MemoryStore {
  values = new Map();
  async get(key, options = {}) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    return options.type === 'json' ? structuredClone(value) : value;
  }
  async setJSON(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { this.values.delete(key); }
  async *list({ prefix }) {
    const blobs = [...this.values.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key }));
    yield { blobs };
  }
}

function request(body, {
  method = 'POST',
  origin = 'https://biohazardtvusa.com',
  contentType = 'application/json',
  ip = '192.0.2.15'
} = {}) {
  return new Request('https://biohazardtvusa.com/.netlify/functions/pageview', {
    method,
    headers: {
      ...(origin === null ? {} : { origin }),
      ...(contentType ? { 'content-type': contentType } : {}),
      ...(ip === null ? {} : { 'x-nf-client-connection-ip': ip }),
      ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(JSON.stringify(body))) })
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

test('records only a coarse homepage page view without visitor or IP identifiers', async () => {
  const store = new MemoryStore();
  const handler = createPageviewHandler({
    store,
    now: () => Date.parse('2026-11-13T12:00:00.000Z'),
    makeId: () => 'test-event'
  });

  const response = await handler(request({
    page: '/',
    source: 'FACEBOOK',
    campaign: 'November Launch!'
  }));

  assert.equal(response.status, 204);
  const event = await store.get('pageviews/2026-11-13/test-event', { type: 'json' });
  assert.deepEqual(event, {
    page: '/',
    source: 'facebook',
    campaign: 'novemberlaunch',
    createdAt: '2026-11-13T12:00:00.000Z'
  });
  assert.equal(JSON.stringify(event).includes('192.0.2.'), false);
  assert.equal(Object.hasOwn(event, 'visitorId'), false);
});

test('rejects cross-origin requests and non-homepage paths', async () => {
  const handler = createPageviewHandler({ store: new MemoryStore() });
  assert.equal((await handler(request({ page: '/' }, { origin: 'https://other.example' }))).status, 403);
  assert.equal((await handler(request({ page: '/customer-portal.html' }))).status, 400);
  assert.equal((await handler(request({ page: '/' }, { contentType: 'text/plain' }))).status, 400);
});

test('removes page-view records older than 90 days', async () => {
  const store = new MemoryStore();
  store.values.set('pageviews/2026-08-14/old', { page: '/', source: 'direct' });
  store.values.set('limits/pageviews/2026-11-12/489600/old-hash', { count: 1 });
  const handler = createPageviewHandler({
    store,
    now: () => Date.parse('2026-11-13T12:00:00.000Z'),
    makeId: () => 'new-event'
  });

  await handler(request({ page: '/', source: 'direct' }));

  assert.equal(store.values.has('pageviews/2026-08-14/old'), false);
  assert.equal(store.values.has('pageviews/2026-11-13/new-event'), true);
  assert.equal(store.values.has('limits/pageviews/2026-11-12/489600/old-hash'), false);
});

test('limits repeated submissions without storing the raw network address', async () => {
  const store = new MemoryStore();
  let id = 0;
  const handler = createPageviewHandler({
    store,
    now: () => Date.parse('2026-11-13T12:00:00.000Z'),
    makeId: () => 'event-' + ++id
  });

  for (let attempt = 0; attempt < 60; attempt++) {
    assert.equal((await handler(request({ page: '/', source: 'direct' }))).status, 204);
  }
  const limited = await handler(request({ page: '/', source: 'direct' }));

  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '3600');
  assert.equal(id, 60);
  assert.equal([...store.values.keys()].some(key => key.includes('192.0.2.15')), false);
  assert.equal(JSON.stringify([...store.values.values()]).includes('192.0.2.15'), false);
});
