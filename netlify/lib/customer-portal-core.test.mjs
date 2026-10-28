import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCustomerPortalHandler } from './customer-portal-core.mjs';

class MemoryStore {
  values = new Map();
  async get(key, options = {}) {
    const value = this.values.get(key);
    if (value === undefined) return null;
    if (options.type === 'json') return structuredClone(value);
    return value;
  }
  async setJSON(key, value) { this.values.set(key, structuredClone(value)); }
  async set(key, value) { this.values.set(key, value); }
  async delete(key) { this.values.delete(key); }
  async *list({ prefix }) {
    const blobs = [...this.values.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key }));
    yield { blobs };
  }
}

function setup() {
  const store = new MemoryStore();
  const messages = [];
  const handler = createCustomerPortalHandler({
    store,
    env: {
      PUBLIC_SITE_URL: 'https://biohazardtvusa.com/',
      RESEND_API_KEY: 'test-api-key',
      RESEND_FROM_EMAIL: 'BIOHAZARDTVUSA <contact@send.biohazardtvusa.com>',
      REVIEW_ADMIN_EMAIL: 'owner@example.com'
    },
    sendMail: async message => { messages.push(message); }
  });
  return { store, messages, handler };
}

async function call(handler, action, { method = 'POST', body, headers = {} } = {}) {
  const request = new Request('https://biohazardtvusa.com/.netlify/functions/customer-portal?action=' + action, {
    method,
    headers: {
      origin: 'https://biohazardtvusa.com',
      'x-nf-client-connection-ip': '192.0.2.15',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const response = await handler(request);
  return { response, body: await response.json() };
}

async function approveRequest(handler, messages, email, { referralCode = '', newClient = false } = {}) {
  const requested = await call(handler, 'request-account', {
    body: { name: email.split('@')[0], email, referralCode }
  });
  assert.equal(requested.response.status, 202);
  const confirmationToken = messages.at(-1).text.match(/#confirm=([a-f0-9]{64})/)?.[1];
  assert.ok(confirmationToken);
  const verified = await call(handler, 'verify-account', { body: { token: confirmationToken } });
  assert.equal(verified.response.status, 200);
  const reviewToken = messages.at(-1).text.match(/#review=([a-f0-9]{64})/)?.[1];
  assert.ok(reviewToken);
  const preview = await call(handler, 'review-info', { body: { token: reviewToken } });
  assert.equal(preview.response.status, 200);
  const decision = await call(handler, 'review-decision', {
    body: {
      token: reviewToken,
      decision: 'approve',
      confirmActiveCustomer: true,
      confirmNewClient: newClient,
      confirmRewardApplied: newClient
    }
  });
  return { preview: preview.body, decision, email };
}

test('approved customers receive unique codes and secure email-link sessions', async () => {
  const { handler, messages } = setup();
  const approved = await approveRequest(handler, messages, 'client@example.com');
  assert.equal(approved.decision.response.status, 200);
  assert.equal(approved.preview.email, 'client@example.com');
  const login = await call(handler, 'request-login', { body: { email: 'client@example.com' } });
  assert.equal(login.response.status, 202);
  const loginToken = messages.at(-1).text.match(/#login=([a-f0-9]{64})/)?.[1];
  assert.ok(loginToken);
  const signedIn = await call(handler, 'consume-login', { body: { token: loginToken } });
  assert.equal(signedIn.response.status, 200);
  assert.match(signedIn.response.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Lax/);
  const cookie = signedIn.response.headers.get('set-cookie').split(';')[0];
  const profile = await call(handler, 'profile', { method: 'GET', headers: { cookie } });
  assert.equal(profile.response.status, 200);
  assert.match(profile.body.referralCode, /^BHTV-[A-F0-9]{10}$/);
  assert.match(profile.body.referralLink, /customer-portal\.html\?ref=/);
  assert.equal(profile.body.appliedMonths, 0);
  assert.equal(profile.body.pendingMonths, 0);
});

test('a referral alerts the owner and is recorded only after Xstream setup and extension', async () => {
  const { handler, messages } = setup();
  await approveRequest(handler, messages, 'referrer@example.com');
  const login = await call(handler, 'request-login', { body: { email: 'referrer@example.com' } });
  const loginToken = messages.at(-1).text.match(/#login=([a-f0-9]{64})/)?.[1];
  const signedIn = await call(handler, 'consume-login', { body: { token: loginToken } });
  const cookie = signedIn.response.headers.get('set-cookie').split(';')[0];
  const profileBefore = await call(handler, 'profile', { method: 'GET', headers: { cookie } });

  const requested = await call(handler, 'request-account', {
    body: { name: 'New Client', email: 'new-client@example.com', referralCode: profileBefore.body.referralCode }
  });
  assert.equal(requested.response.status, 202);
  assert.ok(messages.some(message => message.subject === 'Referral code used — Xstream setup needed'));
  const referralAlert = messages.find(message => message.subject === 'Referral code used — Xstream setup needed');
  assert.deepEqual(referralAlert.to, ['owner@example.com']);
  assert.match(referralAlert.text, /has not yet verified their email/);
  assert.match(referralAlert.text, /referrer@example.com/);
  const confirmToken = messages.at(-1).text.match(/#confirm=([a-f0-9]{64})/)?.[1];
  await call(handler, 'verify-account', { body: { token: confirmToken } });
  const reviewToken = messages.at(-1).text.match(/#review=([a-f0-9]{64})/)?.[1];
  const reviewInfo = await call(handler, 'review-info', { body: { token: reviewToken } });
  assert.equal(reviewInfo.body.referrerEmail, 'referrer@example.com');
  const premature = await call(handler, 'review-decision', {
    body: { token: reviewToken, decision: 'approve', confirmActiveCustomer: true }
  });
  assert.equal(premature.response.status, 400);
  const notExtended = await call(handler, 'review-decision', {
    body: { token: reviewToken, decision: 'approve', confirmActiveCustomer: true, confirmNewClient: true }
  });
  assert.equal(notExtended.response.status, 400);
  const approved = await call(handler, 'review-decision', {
    body: {
      token: reviewToken,
      decision: 'approve',
      confirmActiveCustomer: true,
      confirmNewClient: true,
      confirmRewardApplied: true
    }
  });
  assert.equal(approved.response.status, 200);
  const profileAfter = await call(handler, 'profile', { method: 'GET', headers: { cookie } });
  assert.equal(profileAfter.body.approvedReferrals, 1);
  assert.equal(profileAfter.body.appliedMonths, 1);
  assert.equal(profileAfter.body.pendingMonths, 0);
  assert.equal(profileAfter.body.pendingReferrals, 0);
});

test('invalid and self-referral codes cannot create an account request', async () => {
  const { handler, messages } = setup();
  const invalid = await call(handler, 'request-account', {
    body: { name: 'Customer', email: 'customer@example.com', referralCode: 'NOT-A-CODE' }
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(messages.length, 0);
  await approveRequest(handler, messages, 'client@example.com');
  await call(handler, 'request-login', { body: { email: 'client@example.com' } });
  const loginToken = messages.at(-1).text.match(/#login=([a-f0-9]{64})/)?.[1];
  const signedIn = await call(handler, 'consume-login', { body: { token: loginToken } });
  const cookie = signedIn.response.headers.get('set-cookie').split(';')[0];
  const profile = await call(handler, 'profile', { method: 'GET', headers: { cookie } });
  const selfReferral = await call(handler, 'request-account', {
    body: { name: 'Client', email: 'client@example.com', referralCode: profile.body.referralCode }
  });
  assert.equal(selfReferral.response.status, 202);
  assert.equal(profile.body.appliedMonths, 0);
});

test('a failed initial referral alert is retried when the referred email is verified', async () => {
  const store = new MemoryStore();
  const messages = [];
  const referralCode = 'BHTV-AAAAAAAAAA';
  await store.setJSON('customers/referrer-id', {
    id: 'referrer-id',
    email: 'referrer@example.com',
    name: 'Referrer',
    status: 'active',
    referralCode
  });
  await store.setJSON('referral-codes/' + referralCode, { customerId: 'referrer-id' });
  let failFirstAlert = true;
  const handler = createCustomerPortalHandler({
    store,
    env: {
      PUBLIC_SITE_URL: 'https://biohazardtvusa.com/',
      RESEND_API_KEY: 'test-api-key',
      RESEND_FROM_EMAIL: 'BIOHAZARDTVUSA <contact@send.biohazardtvusa.com>',
      REVIEW_ADMIN_EMAIL: 'owner@example.com'
    },
    sendMail: async message => {
      if (message.subject === 'Referral code used — Xstream setup needed' && failFirstAlert) {
        failFirstAlert = false;
        throw new Error('Temporary mail failure');
      }
      messages.push(message);
    }
  });
  const submitted = await call(handler, 'request-account', {
    body: { name: 'Referred Client', email: 'referred@example.com', referralCode }
  });
  assert.equal(submitted.response.status, 202);
  assert.match(submitted.body.message, /business will receive the referral alert after your address is verified/);
  const confirmationToken = messages.find(message => message.to[0] === 'referred@example.com').text.match(/#confirm=([a-f0-9]{64})/)?.[1];
  const verified = await call(handler, 'verify-account', { body: { token: confirmationToken } });
  assert.equal(verified.response.status, 200);
  const alert = messages.find(message => message.subject === 'Referral code used — Xstream setup needed');
  assert.ok(alert);
  assert.match(alert.text, /has verified their email/);
  assert.ok(messages.some(message => message.subject === 'Verified referral ready for Xstream setup'));
});

test('one-time login links cannot be reused and sessions can be revoked', async () => {
  const { handler, messages } = setup();
  await approveRequest(handler, messages, 'owner@example.net');
  await call(handler, 'request-login', { body: { email: 'owner@example.net' } });
  const token = messages.at(-1).text.match(/#login=([a-f0-9]{64})/)?.[1];
  const first = await call(handler, 'consume-login', { body: { token } });
  assert.equal(first.response.status, 200);
  const second = await call(handler, 'consume-login', { body: { token } });
  assert.equal(second.response.status, 410);
  const cookie = first.response.headers.get('set-cookie').split(';')[0];
  await call(handler, 'logout', { headers: { cookie } });
  const profile = await call(handler, 'profile', { method: 'GET', headers: { cookie } });
  assert.equal(profile.response.status, 401);
});

test('contest tracker counts only owner-approved referrals inside the contest period', async () => {
  let timestamp = Date.parse('2026-11-01T12:00:00.000Z');
  const now = () => timestamp;
  const store = new MemoryStore();
  const adminStore = new MemoryStore();
  const adminToken = 'a'.repeat(64);
  const tokenHash = createHash('sha256').update(adminToken).digest('hex');
  await adminStore.setJSON('access/' + tokenHash, { expiresAt: timestamp + 365 * 24 * 60 * 60 * 1000 });
  const expiredToken = 'b'.repeat(64);
  await adminStore.setJSON('access/' + createHash('sha256').update(expiredToken).digest('hex'), { expiresAt: timestamp - 1 });
  const messages = [];
  const handler = createCustomerPortalHandler({
    store,
    adminStore,
    now,
    env: {
      PUBLIC_SITE_URL: 'https://biohazardtvusa.com/',
      RESEND_API_KEY: 'test-api-key',
      RESEND_FROM_EMAIL: 'BIOHAZARDTVUSA <contact@send.biohazardtvusa.com>',
      REVIEW_ADMIN_EMAIL: 'owner@example.com'
    },
    sendMail: async message => { messages.push(message); }
  });
  const adminHeaders = { authorization: 'Bearer ' + adminToken };
  const unauthorized = await call(handler, 'admin-data', { method: 'GET' });
  assert.equal(unauthorized.response.status, 401);
  const expired = await call(handler, 'admin-data', {
    method: 'GET',
    headers: { authorization: 'Bearer ' + expiredToken }
  });
  assert.equal(expired.response.status, 401);

  await approveRequest(handler, messages, 'contest-referrer@example.com');
  await call(handler, 'request-login', { body: { email: 'contest-referrer@example.com' } });
  const loginToken = messages.at(-1).text.match(/#login=([a-f0-9]{64})/)?.[1];
  const signIn = await call(handler, 'consume-login', { body: { token: loginToken } });
  const cookie = signIn.response.headers.get('set-cookie').split(';')[0];
  const referrerProfile = await call(handler, 'profile', { method: 'GET', headers: { cookie } });

  const contest = await call(handler, 'contest-create', {
    headers: adminHeaders,
    body: {
      name: 'November referral contest',
      startAt: '2026-11-01T00:00:00.000Z',
      endAt: '2026-11-30T23:59:59.999Z'
    }
  });
  assert.equal(contest.response.status, 201);

  timestamp = Date.parse('2026-10-31T12:00:00.000Z');
  await approveRequest(handler, messages, 'outside-period@example.com', {
    referralCode: referrerProfile.body.referralCode,
    newClient: true
  });
  timestamp = Date.parse('2026-11-03T12:00:00.000Z');
  await approveRequest(handler, messages, 'inside-period@example.com', {
    referralCode: referrerProfile.body.referralCode,
    newClient: true
  });

  const results = await call(handler, 'contest-results&id=' + contest.body.contest.id, {
    method: 'GET',
    headers: adminHeaders
  });
  assert.equal(results.response.status, 200);
  assert.equal(results.body.leaderboard.length, 1);
  assert.equal(results.body.leaderboard[0].email, 'contest-referrer@example.com');
  assert.equal(results.body.leaderboard[0].referrals, 1);

  const profileDuringContest = await call(handler, 'profile', { method: 'GET', headers: { cookie } });
  assert.equal(profileDuringContest.body.activeContests[0].referrals, 1);
  const adminData = await call(handler, 'admin-data', { method: 'GET', headers: adminHeaders });
  assert.equal(adminData.body.totals.approvedReferrals, 2);
  assert.equal(adminData.body.leaderboard.find(person => person.email === 'contest-referrer@example.com').referrals, 2);
});
