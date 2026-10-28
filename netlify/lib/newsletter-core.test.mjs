import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createNewsletterHandler } from './newsletter-core.mjs';

class MemoryStore {
  values = new Map();

  async get(key) {
    const value = this.values.get(key);
    return value === undefined ? null : structuredClone(value);
  }

  async setJSON(key, value) {
    this.values.set(key, structuredClone(value));
  }

  async delete(key) {
    this.values.delete(key);
  }

  async *list({ prefix }) {
    yield {
      blobs: [...this.values.keys()]
        .filter(key => key.startsWith(prefix))
        .map(key => ({ key }))
    };
  }
}

const email = 'fan@example.com';
const input = {
  email,
  firstName: 'Fan',
  state: 'TX',
  consent: true
};

function setup({ failMail = false, startTime = 1_800_000_000_000 } = {}) {
  const store = new MemoryStore();
  const messages = [];
  let time = startTime;
  const env = {
    PUBLIC_SITE_URL: 'https://biohazardtvusa.com/',
    RESEND_API_KEY: 'test-key',
    RESEND_FROM_EMAIL: 'BIOHAZARDTVUSA <updates@send.biohazardtvusa.com>',
    REVIEW_ADMIN_EMAIL: 'owner@example.com'
  };
  const handler = createNewsletterHandler({
    store,
    env,
    now: () => time,
    sendMail: async message => {
      if (failMail) throw new Error('mail failure');
      messages.push(message);
    }
  });
  return { handler, store, messages, setTime: value => { time = value; } };
}

function request(action, { method = 'GET', body, headers = {} } = {}) {
  const requestHeaders = {
    origin: 'https://biohazardtvusa.com',
    'x-nf-client-connection-ip': '203.0.113.7',
    ...headers
  };
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  return new Request(`https://biohazardtvusa.com/.netlify/functions/newsletter?action=${action}`, {
    method,
    headers: requestHeaders,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });
}

async function jsonResponse(response) {
  return response.json();
}

function confirmationToken(message) {
  const match = message.text.match(/email-confirmation\.html#token=([a-f0-9]{64})/);
  assert.ok(match, 'confirmation email should contain a token link');
  return match[1];
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('signup stays pending until the user confirms, then export includes personal unsubscribe links', async () => {
  const { handler, store, messages } = setup();
  const signup = await handler(request('signup', { method: 'POST', body: input }));
  assert.equal(signup.status, 202);
  assert.match((await jsonResponse(signup)).message, /confirmation link/i);
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].to, [email]);
  assert.match(messages[0].subject, /Confirm/);

  const token = confirmationToken(messages[0]);
  const subscriberKey = 'subscribers/' + sha256(email);
  const pending = await store.get(subscriberKey);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.emailOwnershipVerified, false);

  const scannerGet = await handler(request('confirm', { method: 'GET' }));
  assert.equal(scannerGet.status, 405);
  assert.equal((await store.get(subscriberKey)).status, 'pending');

  const confirm = await handler(request('confirm', { method: 'POST', body: { token } }));
  assert.equal(confirm.status, 200);
  assert.match((await jsonResponse(confirm)).message, /confirmed/i);
  const active = await store.get(subscriberKey);
  assert.equal(active.status, 'active');
  assert.equal(active.emailOwnershipVerified, true);
  assert.ok(active.confirmedAt);
  assert.match(active.unsubscribeToken, /^[a-f0-9]{64}$/);

  const repeatedConfirm = await handler(request('confirm', { method: 'POST', body: { token } }));
  assert.equal(repeatedConfirm.status, 200);

  const access = await handler(request('request-access', { method: 'POST' }));
  assert.equal(access.status, 202);
  const accessEmail = messages.at(-1);
  const accessMatch = accessEmail.text.match(/email-list\.html#access=([a-f0-9]{64})/);
  assert.ok(accessMatch, 'admin access email should contain its token');
  const exported = await handler(request('export', {
    headers: { authorization: 'Bearer ' + accessMatch[1] }
  }));
  assert.equal(exported.status, 200);
  const csv = await exported.text();
  assert.match(csv, /Email ownership verified/);
  assert.match(csv, /Unsubscribe URL/);
  assert.match(csv, /List-Unsubscribe-Post header value/);
  assert.match(csv, /email-unsubscribe\.html#token=/);
  assert.match(csv, /List-Unsubscribe=One-Click/);
  assert.match(csv, /"Yes"/);
});

test('one-click unsubscribe removes a confirmed address from future exports', async () => {
  const { handler, store, messages } = setup();
  await handler(request('signup', { method: 'POST', body: input }));
  const token = confirmationToken(messages[0]);
  await handler(request('confirm', { method: 'POST', body: { token } }));
  const subscriberKey = 'subscribers/' + sha256(email);
  const active = await store.get(subscriberKey);
  const unsubscribeToken = active.unsubscribeToken;

  const unsubscribed = await handler(request('one-click-unsubscribe&token=' + unsubscribeToken, {
    method: 'POST',
    headers: { origin: 'https://mail.google.com' }
  }));
  assert.equal(unsubscribed.status, 200);
  assert.match((await jsonResponse(unsubscribed)).message, /unsubscribed/i);
  const record = await store.get(subscriberKey);
  assert.equal(record.status, 'unsubscribed');
  assert.equal(record.emailOwnershipVerified, false);
  assert.equal('unsubscribeToken' in record, false);

  const repeat = await handler(request('one-click-unsubscribe&token=' + unsubscribeToken, { method: 'POST' }));
  assert.equal(repeat.status, 200);
});

test('expired confirmations cannot activate an address and a later signup can issue a fresh link', async () => {
  const { handler, messages, setTime } = setup();
  await handler(request('signup', { method: 'POST', body: input }));
  const firstToken = confirmationToken(messages[0]);
  setTime(1_800_000_000_000 + 73 * 60 * 60 * 1000);
  const expired = await handler(request('confirm', { method: 'POST', body: { token: firstToken } }));
  assert.equal(expired.status, 410);

  const retry = await handler(request('signup', { method: 'POST', body: input }));
  assert.equal(retry.status, 202);
  assert.equal(messages.length, 2);
  assert.notEqual(confirmationToken(messages[1]), firstToken);
});

test('signup fails explicitly when confirmation email cannot be sent', async () => {
  const { handler, store } = setup({ failMail: true });
  const response = await handler(request('signup', { method: 'POST', body: input }));
  assert.equal(response.status, 503);
  const record = await store.get('subscribers/' + sha256(email));
  assert.equal(record.status, 'pending');
  assert.equal(record.confirmationTokenHash, null);
  assert.equal(record.confirmationSentAt, null);
});

test('unconfirmed legacy addresses are not counted as active subscribers', async () => {
  const { handler, store, messages } = setup();
  await store.setJSON('subscribers/' + sha256(email), {
    email, firstName: 'Fan', state: 'TX', status: 'active',
    emailOwnershipVerified: false, consentedAt: '2026-01-01T00:00:00.000Z'
  });
  const access = await handler(request('request-access', { method: 'POST' }));
  assert.equal(access.status, 202);
  const token = messages[0].text.match(/email-list\.html#access=([a-f0-9]{64})/)[1];
  const summary = await handler(request('summary', { headers: { authorization: 'Bearer ' + token } }));
  assert.equal(summary.status, 200);
  assert.deepEqual(await jsonResponse(summary), { active: 0, texas: 0, other: 0 });
});

test('marketing consent remains required', async () => {
  const { handler, messages } = setup();
  const response = await handler(request('signup', { method: 'POST', body: { ...input, consent: false } }));
  assert.equal(response.status, 400);
  assert.equal(messages.length, 0);
});
