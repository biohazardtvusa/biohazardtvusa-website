import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { URL as WebURL } from 'node:url';
import { promisify } from 'node:util';

const LOGIN_TTL_MS = 20 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
const REVIEW_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PASSWORD_HASH_BYTES = 64;
const PASSWORD_SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const scrypt = promisify(scryptCallback);
const COOKIE = 'biohazard_customer_session';
const ACCOUNT_REQUEST_MESSAGE = 'If this address already has portal access, use the sign-in form. Otherwise, check email for verification and await business review.';
const hash = value => createHash('sha256').update(value).digest('hex');
const validToken = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const normalizeEmail = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const validEmail = value => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const validCode = value => typeof value === 'string' && /^BHTV-[A-F0-9]{10}$/.test(value);
const validPassword = value => typeof value === 'string' && value.length >= 12 && value.length <= 128 && !/[\u0000-\u001f\u007f]/.test(value);
const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
async function passwordCredentials(password) {
  const passwordSalt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, passwordSalt, PASSWORD_HASH_BYTES, PASSWORD_SCRYPT_OPTIONS);
  return { passwordSalt, passwordHash: Buffer.from(derived).toString('hex') };
}
async function passwordMatches(password, credentials) {
  const salt = typeof credentials?.passwordSalt === 'string' ? credentials.passwordSalt : 'biohazardtvusa-password-timing-salt';
  const expected = /^[a-f0-9]{128}$/.test(credentials?.passwordHash || '')
    ? Buffer.from(credentials.passwordHash, 'hex')
    : Buffer.alloc(PASSWORD_HASH_BYTES);
  const derived = Buffer.from(await scrypt(password, salt, PASSWORD_HASH_BYTES, PASSWORD_SCRYPT_OPTIONS));
  return timingSafeEqual(expected, derived) && Boolean(credentials?.passwordHash);
}
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex',
    ...headers
  }
});
async function parseBody(request, maxLength = 4096) {
  if (Number(request.headers.get('content-length')) > maxLength) throw new Error('body');
  if (!(request.headers.get('content-type') || '').includes('application/json')) throw new Error('content-type');
  const text = await request.text();
  if (text.length > maxLength) throw new Error('body');
  return JSON.parse(text);
}

export function createCustomerPortalHandler({ store, adminStore, env = {}, sendMail, now = () => Date.now() }) {
  const siteBase = env.PUBLIC_SITE_URL || 'https://biohazardtvusa.com/';
  const read = async key => store.get(key, { type: 'json' });
  const write = async (key, value) => store.setJSON(key, value);
  const emailKey = email => 'customers/' + hash(email);
  const applicationKey = email => 'applications/' + hash(email);
  const emailConfigured = () => Boolean(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL && typeof sendMail === 'function');
  const validContestId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

  async function listRecords(prefix) {
    const records = [];
    for await (const page of store.list({ prefix, paginate: true })) {
      for (const blob of page.blobs) {
        const record = await read(blob.key);
        if (record) records.push(record);
      }
    }
    return records;
  }

  async function limited(scope, identity, max) {
    const hour = Math.floor(now() / 3600000);
    const key = 'limits/' + scope + '/' + hash(String(identity) + ':' + hour);
    const prior = await read(key);
    if ((prior?.count || 0) >= max) return true;
    await write(key, { count: (prior?.count || 0) + 1 });
    return false;
  }

  async function rateLimited(request, scope, email, emailMax = 4) {
    const ip = request.headers.get('x-nf-client-connection-ip') || 'unknown';
    return await limited(scope + '-ip', ip, 8) || await limited(scope + '-email', email, emailMax);
  }

  async function adminAuthorized(request) {
    const token = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
    if (!validToken(token) || !adminStore) return false;
    const record = await adminStore.get('access/' + hash(token), { type: 'json' });
    return Boolean(record && record.expiresAt > now());
  }

  function getSessionToken(request) {
    const cookie = request.headers.get('cookie') || '';
    const match = cookie.split(';').map(part => part.trim()).find(part => part.startsWith(COOKIE + '='));
    return match ? match.slice(COOKIE.length + 1) : '';
  }

  function sessionCookie(token, maxAge = Math.floor(SESSION_TTL_MS / 1000)) {
    return COOKIE + '=' + encodeURIComponent(token) + '; Path=/.netlify/functions/customer-portal; Max-Age=' +
      maxAge + '; HttpOnly; Secure; SameSite=Lax';
  }

  async function currentCustomer(request) {
    const token = getSessionToken(request);
    if (!validToken(token)) return null;
    const sessionKey = 'sessions/' + hash(token);
    const session = await read(sessionKey);
    if (!session || session.expiresAt <= now()) {
      if (session) await store.delete(sessionKey);
      return null;
    }
    const customer = await read('customers/' + session.customerId);
    return customer?.status === 'active' ? customer : null;
  }

  async function startSession(customer) {
    const sessionToken = randomBytes(32).toString('hex');
    await write('sessions/' + hash(sessionToken), { customerId: customer.id, expiresAt: now() + SESSION_TTL_MS });
    return json(200, { ok: true }, { 'set-cookie': sessionCookie(sessionToken) });
  }

  async function revokeCustomerSessions(customerId) {
    for await (const page of store.list({ prefix: 'sessions/', paginate: true })) {
      for (const blob of page.blobs) {
        const session = await read(blob.key);
        if (session?.customerId === customerId) await store.delete(blob.key);
      }
    }
  }

  async function revokeCustomerPasswordResets(customerId) {
    for await (const page of store.list({ prefix: 'password-resets/', paginate: true })) {
      for (const blob of page.blobs) {
        const reset = await read(blob.key);
        if (reset?.customerId === customerId) await store.delete(blob.key);
      }
    }
  }

  function mailUrl(page, token, action = 'token') {
    const link = new WebURL(page, siteBase);
    link.hash = action + '=' + token;
    return link.href;
  }

  async function sendLoginLink(customer) {
    const token = randomBytes(32).toString('hex');
    await write('login-tokens/' + hash(token), {
      customerId: customer.id,
      expiresAt: now() + LOGIN_TTL_MS
    });
    try {
      const url = mailUrl('/customer-portal.html', token, 'login');
      await sendMail({
        from: env.RESEND_FROM_EMAIL.trim(),
        to: [customer.email],
        subject: 'Your BIOHAZARDTVUSA customer portal sign-in link',
        text: 'Use this one-time link to sign in to your BIOHAZARDTVUSA customer portal:\n\n' +
          url + '\n\nIt expires in 20 minutes. If you did not request it, ignore this email.',
        html: '<!doctype html><html lang="en"><body style="margin:0;background:#0b0c10;color:#f7f1e5;font:16px/1.6 Arial,sans-serif;padding:32px 16px"><main style="max-width:560px;margin:auto;padding:28px;background:#16171d;border:1px solid #35302a;border-radius:14px"><h1 style="color:#e6bd62">BIOHAZARDTVUSA</h1><p>Use this one-time link to sign in to your customer portal.</p><p><a href="' + escapeHtml(url) + '" style="display:inline-block;padding:14px 20px;background:#e6bd62;color:#151515;text-decoration:none;font-weight:bold;border-radius:8px">Sign in securely</a></p><p>This link expires in 20 minutes. If you did not request it, ignore this email.</p></main></body></html>'
      });
    } catch (error) {
      await store.delete('login-tokens/' + hash(token));
      throw error;
    }
  }

  async function notifyAdmin(requestKey, requestRecord) {
    if (!env.REVIEW_ADMIN_EMAIL || !emailConfigured()) throw new Error('Customer review email is not configured.');
    const token = randomBytes(32).toString('hex');
    const tokenKey = 'reviews/' + hash(token);
    await write(tokenKey, { requestKey, expiresAt: now() + REVIEW_TTL_MS });
    const link = mailUrl('/customer-review.html', token, 'review');
    const referrer = requestRecord.referrerId ? await read('customers/' + requestRecord.referrerId) : null;
    const referralText = requestRecord.referralCode
      ? 'Referral code used: ' + requestRecord.referralCode + '\nReferring client: ' + (referrer?.name || 'Unknown') +
        ' <' + (referrer?.email || 'unknown') + '>\nBefore approving, create the new client’s Xstream account and extend the referring client’s subscription by one month.'
      : 'No referral code was provided.';
    try {
      await sendMail({
        from: env.RESEND_FROM_EMAIL.trim(),
        to: [env.REVIEW_ADMIN_EMAIL.trim()],
        subject: requestRecord.referralCode ? 'Verified referral ready for Xstream setup' : 'Customer portal access request to review',
        text: 'A customer verified their email and requested portal access.\n\nName: ' + requestRecord.name +
          '\nEmail: ' + requestRecord.email + '\n' + referralText +
          '\n\nConfirm the customer is active and the Xstream account is set up before approving. For a referral, confirm they are a new client and that you extended the referring client’s subscription by one month.\n\nReview securely:\n' +
          link + '\n\nThis one-time review link expires in 30 days.',
        html: '<!doctype html><html lang="en"><body style="margin:0;background:#0b0c10;color:#f7f1e5;font:16px/1.6 Arial,sans-serif;padding:32px 16px"><main style="max-width:560px;margin:auto;padding:28px;background:#16171d;border:1px solid #35302a;border-radius:14px"><h1 style="color:#e6bd62">Customer portal request</h1><p><strong>Name:</strong> ' +
          escapeHtml(requestRecord.name) + '<br><strong>Email:</strong> ' + escapeHtml(requestRecord.email) + '<br><strong>Referral code:</strong> ' +
          escapeHtml(requestRecord.referralCode || 'None') + (referrer ? '<br><strong>Referring client:</strong> ' +
            escapeHtml(referrer.name) + ' &lt;' + escapeHtml(referrer.email) + '&gt;' : '') +
          '</p><p>Confirm the customer is active and the Xstream account is set up before approving. For a referral, confirm they are a new client and extend the referring client’s subscription by one month in Xstream before approving.</p><p><a href="' +
          escapeHtml(link) + '" style="display:inline-block;padding:14px 20px;background:#e6bd62;color:#151515;text-decoration:none;font-weight:bold;border-radius:8px">Review account request</a></p><p>This one-time review link expires in 30 days.</p></main></body></html>'
      });
      await write(requestKey, { ...requestRecord, adminNotifiedAt: now() });
    } catch (error) {
      // The one-time link remains usable if the email provider's response is uncertain.
      throw error;
    }
  }

  async function notifyReferralUse(requestKey, requestRecord) {
    if (!requestRecord.referralCode || requestRecord.referralUseNotifiedAt) return requestRecord;
    if (!env.REVIEW_ADMIN_EMAIL || !emailConfigured()) throw new Error('Referral alert email is not configured.');
    const referrer = requestRecord.referrerId ? await read('customers/' + requestRecord.referrerId) : null;
    const verificationNote = requestRecord.status === 'verified_pending_admin'
      ? 'The referred person has verified their email. A separate secure review email will arrive.'
      : 'This is an immediate alert only; the referred person has not yet verified their email. A separate secure review email will arrive after verification.';
    await sendMail({
      from: env.RESEND_FROM_EMAIL.trim(),
      to: [env.REVIEW_ADMIN_EMAIL.trim()],
      subject: 'Referral code used — Xstream setup needed',
      text: 'A new customer submitted a BIOHAZARDTVUSA referral code.\n\nReferred person: ' + requestRecord.name +
        ' <' + requestRecord.email + '>\nReferral code: ' + requestRecord.referralCode +
        '\nReferring client: ' + (referrer?.name || 'Unknown') + ' <' + (referrer?.email || 'unknown') +
        '>\n\n' + verificationNote + ' Create the new client’s Xstream account and extend the referring client’s subscription by one month before approving that review.',
      html: '<!doctype html><html lang="en"><body style="margin:0;background:#0b0c10;color:#f7f1e5;font:16px/1.6 Arial,sans-serif;padding:32px 16px"><main style="max-width:560px;margin:auto;padding:28px;background:#16171d;border:1px solid #35302a;border-radius:14px"><h1 style="color:#e6bd62">Referral code used</h1><p><strong>Referred person:</strong> ' +
        escapeHtml(requestRecord.name) + ' &lt;' + escapeHtml(requestRecord.email) + '&gt;<br><strong>Referral code:</strong> ' +
        escapeHtml(requestRecord.referralCode) + '<br><strong>Referring client:</strong> ' +
        escapeHtml(referrer?.name || 'Unknown') + ' &lt;' + escapeHtml(referrer?.email || 'unknown') +
        '&gt;</p><p>' + escapeHtml(verificationNote) + ' Create the new client’s Xstream account and extend the referring client’s subscription by one month before approving that review.</p></main></body></html>'
    });
    const updated = { ...requestRecord, referralUseNotifiedAt: now() };
    await write(requestKey, updated);
    return updated;
  }

  async function accountRequest(request) {
    if (request.method !== 'POST') return json(405, { error: 'Use the customer account form on the website.' });
    if (!emailConfigured() || !env.REVIEW_ADMIN_EMAIL) return json(503, { error: 'Customer account email is not configured. Please contact us on WhatsApp.' });
    if (await rateLimited(request, 'account-request', 'anonymous', 20)) return json(429, { error: 'Please wait before submitting another request.' });
    let input;
    try { input = await parseBody(request); } catch { return json(400, { error: 'Enter your name and email address.' }); }
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    const email = normalizeEmail(input?.email);
    const password = typeof input?.password === 'string' ? input.password : '';
    const passwordConfirm = typeof input?.passwordConfirm === 'string' ? input.passwordConfirm : '';
    const referralCode = typeof input?.referralCode === 'string' ? input.referralCode.trim().toUpperCase() : '';
    if (name.length < 2 || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name) || !validEmail(email)) {
      return json(400, { error: 'Enter a valid name and email address.' });
    }
    if (!validPassword(password) || password !== passwordConfirm) {
      return json(400, { error: 'Choose a password of at least 12 characters and enter it the same way twice.' });
    }
    if (referralCode && !validCode(referralCode)) return json(400, { error: 'That referral code is not valid. Check it with the client who shared it.' });
    if (await rateLimited(request, 'account-request-email', email, 3)) return json(429, { error: 'Please wait before submitting another request for this address.' });
    const existingCustomer = await read(emailKey(email));
    if (existingCustomer?.status === 'active') {
      return json(202, { message: ACCOUNT_REQUEST_MESSAGE });
    }
    const requestKey = applicationKey(email);
    const prior = await read(requestKey);
    if (prior?.status === 'verified_pending_admin') {
      if (prior.adminNotifiedAt > now() - 24 * 60 * 60 * 1000) {
        return json(202, { message: ACCOUNT_REQUEST_MESSAGE });
      }
      try {
        const updated = await notifyReferralUse(requestKey, prior);
        await notifyAdmin(requestKey, updated);
      } catch {
        return json(503, { error: 'We could not notify the business about your request. Please contact us on WhatsApp.' });
      }
      return json(202, { message: ACCOUNT_REQUEST_MESSAGE });
    }
    let referrerId = null;
    if (referralCode) {
      const index = await read('referral-codes/' + referralCode);
      const referrer = index?.customerId ? await read('customers/' + index.customerId) : null;
      if (!referrer || referrer.status !== 'active') return json(400, { error: 'We could not verify that referral code. Ask the referring client to check it.' });
      if (referrer.email === email) return json(400, { error: 'You cannot use your own referral code.' });
      referrerId = referrer.id;
    }
    const credentials = await passwordCredentials(password);
    const token = randomBytes(32).toString('hex');
    const sameReferral = ['email_verification_pending', 'email_delivery_failed'].includes(prior?.status) &&
      prior?.referralCode === (referralCode || null) && prior?.referrerId === referrerId;
    let record = {
      id: prior?.id || randomBytes(16).toString('hex'),
      email,
      name,
      ...credentials,
      referralCode: referralCode || null,
      referrerId,
      status: 'email_verification_pending',
      createdAt: prior?.createdAt || new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(),
      confirmationTokenHash: hash(token),
      confirmationExpiresAt: now() + TOKEN_TTL_MS,
      adminNotifiedAt: null,
      referralUseNotifiedAt: sameReferral ? prior.referralUseNotifiedAt || null : null
    };
    await write(requestKey, record);
    const tokenKey = 'confirmations/' + hash(token);
    await write(tokenKey, { requestKey, expiresAt: record.confirmationExpiresAt });
    const link = mailUrl('/', token, 'confirm');
    if (record.referralCode && !record.referralUseNotifiedAt) {
      try { record = await notifyReferralUse(requestKey, record); } catch {}
    }
    try {
      await sendMail({
        from: env.RESEND_FROM_EMAIL.trim(),
        to: [email],
        subject: 'Verify your BIOHAZARDTVUSA customer portal request',
        text: 'Verify this email address to request BIOHAZARDTVUSA customer portal access:\n\n' +
          link + '\n\nThe link expires in 24 hours. After verifying, the business reviews your request. This is not an order or payment confirmation.',
        html: '<!doctype html><html lang="en"><body style="margin:0;background:#0b0c10;color:#f7f1e5;font:16px/1.6 Arial,sans-serif;padding:32px 16px"><main style="max-width:560px;margin:auto;padding:28px;background:#16171d;border:1px solid #35302a;border-radius:14px"><h1 style="color:#e6bd62">Verify your email</h1><p>Verify this address to request BIOHAZARDTVUSA customer portal access. The business reviews requests before enabling an account. After approval, sign in with the password you created.</p><p><a href="' +
          escapeHtml(link) + '" style="display:inline-block;padding:14px 20px;background:#e6bd62;color:#151515;text-decoration:none;font-weight:bold;border-radius:8px">Verify email address</a></p><p>This link expires in 24 hours. This is not an order or payment confirmation.</p></main></body></html>'
      });
    } catch {
      await store.delete(tokenKey);
      await write(requestKey, { ...record, status: prior?.status === 'email_verification_pending' ? prior.status : 'email_delivery_failed', confirmationTokenHash: null });
      return json(503, { error: 'We could not send the verification email. Please try again later or contact us on WhatsApp.' });
    }
    const message = record.referralCode
      ? (record.referralUseNotifiedAt
          ? 'Check your email to verify this request. The business was alerted that the referral code was used; they will review the Xstream setup before approving.'
          : 'Check your email to verify this request. The business will receive the referral alert after your address is verified.')
      : ACCOUNT_REQUEST_MESSAGE;
    return json(202, { message });
  }

  async function verifyAccount(request) {
    if (request.method !== 'POST') return json(405, { error: 'Use the verification button on the website.' });
    let input;
    try { input = await parseBody(request); } catch { return json(400, { error: 'This verification link is invalid.' }); }
    const token = input?.token;
    if (!validToken(token)) return json(400, { error: 'This verification link is invalid.' });
    const tokenKey = 'confirmations/' + hash(token);
    const confirmation = await read(tokenKey);
    if (!confirmation || confirmation.expiresAt <= now()) return json(410, { error: 'This verification link expired. Submit your request again.' });
    let requestRecord = await read(confirmation.requestKey);
    if (!requestRecord) return json(410, { error: 'This customer request is no longer available.' });
    if (requestRecord.status === 'approved') return json(200, {
      message: requestRecord.passwordHash
        ? 'Your account is approved. Sign in on the homepage using the password you created.'
        : 'Your account is approved. Use Password help on the homepage to set a password.'
    });
    if (requestRecord.status === 'rejected') return json(410, { error: 'This customer portal request was not approved. Contact us on WhatsApp if you need help.' });
    if (requestRecord.confirmationTokenHash !== hash(token) && requestRecord.status !== 'verified_pending_admin') {
      return json(410, { error: 'This verification link is no longer active.' });
    }
    if (requestRecord.status === 'email_verification_pending') {
      requestRecord.status = 'verified_pending_admin';
      requestRecord.verifiedAt = new Date(now()).toISOString();
      requestRecord.confirmationTokenHash = null;
      requestRecord.updatedAt = new Date(now()).toISOString();
      await write(confirmation.requestKey, requestRecord);
    }
    if (requestRecord.referralCode && !requestRecord.referralUseNotifiedAt) {
      try { requestRecord = await notifyReferralUse(confirmation.requestKey, requestRecord); } catch {
        return json(503, { error: 'Your email is verified, but the business could not receive the referral alert. Please contact us on WhatsApp.' });
      }
    }
    if (!requestRecord.adminNotifiedAt) {
      try { await notifyAdmin(confirmation.requestKey, requestRecord); } catch {
        return json(503, { error: 'Your email is verified, but the business could not be notified. Please contact us on WhatsApp so we can review your request.' });
      }
    }
    return json(200, { message: 'Your email is verified. The business will review your customer access request.' });
  }

  async function requestLogin(request) {
    if (request.method !== 'POST') return json(405, { error: 'Use the sign-in form on the website.' });
    if (!emailConfigured()) return json(503, { error: 'Customer sign-in email is not configured. Please contact us on WhatsApp.' });
    let input;
    try { input = await parseBody(request); } catch { return json(400, { error: 'Enter your email address.' }); }
    const email = normalizeEmail(input?.email);
    if (!validEmail(email)) return json(400, { error: 'Enter a valid email address.' });
    if (await rateLimited(request, 'login', email, 4)) return json(429, { error: 'Please wait before requesting another sign-in email.' });
    const customer = await read(emailKey(email));
    if (customer?.status === 'active' && !customer.passwordHash) {
      try { await sendLoginLink(customer); } catch {
        return json(503, { error: 'We could not send a sign-in email. Please try again later or contact us on WhatsApp.' });
      }
    }
    return json(202, { message: 'Password sign-in is available on the homepage. If an older approved account still needs a password, use Password help to receive a setup link.' });
  }

  async function passwordLogin(request) {
    if (request.method !== 'POST') return json(405, { error: 'Use the sign-in form on the website.' });
    let input;
    try { input = await parseBody(request); } catch { return json(400, { error: 'Enter your email and password.' }); }
    const email = normalizeEmail(input?.email);
    const password = typeof input?.password === 'string' ? input.password : '';
    if (!validEmail(email) || !validPassword(password)) return json(400, { error: 'Enter your email and password.' });
    if (await rateLimited(request, 'password-login', email, 8)) return json(429, { error: 'Too many sign-in attempts. Wait a while and try again.' });
    const customer = await read(emailKey(email));
    const matches = await passwordMatches(password, customer);
    if (customer?.status !== 'active' || !matches) {
      return json(401, { error: 'Email or password did not match an approved account. If this is your first sign-in, use Password help to set a password.' });
    }
    return startSession(customer);
  }

  async function requestPasswordReset(request) {
    if (request.method !== 'POST') return json(405, { error: 'Use the password help form on the website.' });
    if (!emailConfigured()) return json(503, { error: 'Password help email is not available. Please contact us on WhatsApp.' });
    let input;
    try { input = await parseBody(request); } catch { return json(400, { error: 'Enter your email address.' }); }
    const email = normalizeEmail(input?.email);
    if (!validEmail(email)) return json(400, { error: 'Enter a valid email address.' });
    if (await rateLimited(request, 'password-reset', email, 4)) return json(429, { error: 'Please wait before requesting another password email.' });
    const customer = await read(emailKey(email));
    if (customer?.status === 'active') {
      const token = randomBytes(32).toString('hex');
      const tokenKey = 'password-resets/' + hash(token);
      await write(tokenKey, { customerId: customer.id, expiresAt: now() + PASSWORD_RESET_TTL_MS });
      const link = mailUrl('/', token, 'password-reset');
      try {
        await sendMail({
          from: env.RESEND_FROM_EMAIL.trim(),
          to: [customer.email],
          subject: 'Set or reset your BIOHAZARDTVUSA password',
          text: 'Use this one-time link to set or reset the password for your BIOHAZARDTVUSA customer portal:\n\n' +
            link + '\n\nIt expires in 30 minutes. If you did not request this, ignore this email.',
          html: '<!doctype html><html lang="en"><body style="margin:0;background:#0b0c10;color:#f7f1e5;font:16px/1.6 Arial,sans-serif;padding:32px 16px"><main style="max-width:560px;margin:auto;padding:28px;background:#16171d;border:1px solid #35302a;border-radius:14px"><h1 style="color:#e6bd62">Set or reset your password</h1><p>Use this one-time link to choose a password for your BIOHAZARDTVUSA customer portal.</p><p><a href="' +
            escapeHtml(link) + '" style="display:inline-block;padding:14px 20px;background:#e6bd62;color:#151515;text-decoration:none;font-weight:bold;border-radius:8px">Choose password</a></p><p>This link expires in 30 minutes. If you did not request this, ignore this email.</p></main></body></html>'
        });
      } catch {
        await store.delete(tokenKey);
        return json(503, { error: 'We could not send password help email. Please try again later.' });
      }
    }
    return json(202, { message: 'If that address belongs to an approved client account, password instructions are on the way.' });
  }

  async function consumePasswordReset(request) {
    if (request.method !== 'POST') return json(405, { error: 'Use the password form on the website.' });
    let input;
    try { input = await parseBody(request); } catch { return json(400, { error: 'This password link is invalid.' }); }
    const token = input?.token;
    const password = typeof input?.password === 'string' ? input.password : '';
    const passwordConfirm = typeof input?.passwordConfirm === 'string' ? input.passwordConfirm : '';
    if (!validToken(token)) return json(400, { error: 'This password link is invalid.' });
    if (!validPassword(password) || password !== passwordConfirm) {
      return json(400, { error: 'Choose a password of at least 12 characters and enter it the same way twice.' });
    }
    const tokenKey = 'password-resets/' + hash(token);
    const reset = await read(tokenKey);
    if (!reset || reset.expiresAt <= now()) {
      if (reset) await store.delete(tokenKey);
      return json(410, { error: 'This password link expired. Request a new one.' });
    }
    const customer = await read('customers/' + reset.customerId);
    if (customer?.status !== 'active') {
      await store.delete(tokenKey);
      return json(410, { error: 'This customer account is not active.' });
    }
    const credentials = await passwordCredentials(password);
    await write(emailKey(customer.email), { ...customer, ...credentials, passwordUpdatedAt: new Date(now()).toISOString() });
    await store.delete(tokenKey);
    await revokeCustomerSessions(customer.id);
    await revokeCustomerPasswordResets(customer.id);
    return startSession({ ...customer, ...credentials });
  }

  async function consumeLogin(request) {
    if (request.method !== 'POST') return json(405, { error: 'Use the sign-in button on the website.' });
    let input;
    try { input = await parseBody(request); } catch { return json(400, { error: 'This sign-in link is invalid.' }); }
    const token = input?.token;
    if (!validToken(token)) return json(400, { error: 'This sign-in link is invalid.' });
    const loginKey = 'login-tokens/' + hash(token);
    const login = await read(loginKey);
    if (!login || login.expiresAt <= now()) return json(410, { error: 'This sign-in link expired. Request a new one.' });
    const customer = await read('customers/' + login.customerId);
    if (customer?.status !== 'active') {
      await store.delete(loginKey);
      return json(410, { error: 'This customer account is not active. Contact us on WhatsApp for help.' });
    }
    await store.delete(loginKey);
    return startSession(customer);
  }

  async function profile(request) {
    if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' });
    const customer = await currentCustomer(request);
    if (!customer) return json(401, { error: 'Sign in to view your customer portal.' });
    const referrals = await listRecords('referrals/' + customer.id + '/');
    const applications = await listRecords('applications/');
    const allReferrals = await listRecords('referrals/');
    const contests = await listRecords('contests/');
    const referralsByCustomer = new Map(referrals
      .filter(item => item.referredCustomerId)
      .map(item => [item.referredCustomerId, item]));
    const referredApplications = applications.filter(item => item.referrerId === customer.id && item.email);
    const matchedReferralCustomers = new Set();
    const referralActivity = referredApplications.map(application => {
      const referredCustomerId = hash(application.email);
      const referral = referralsByCustomer.get(referredCustomerId);
      if (referral) matchedReferralCustomers.add(referredCustomerId);
      return {
        firstName: typeof application.name === 'string' ? application.name.trim().split(/\s+/)[0] || 'Referred client' : 'Referred client',
        submittedAt: application.createdAt || application.updatedAt || '',
        status: referral?.status || application.status
      };
    });
    for (const referral of referrals) {
      if (!referral.referredCustomerId || matchedReferralCustomers.has(referral.referredCustomerId)) continue;
      referralActivity.push({
        firstName: 'Referred client',
        submittedAt: referral.earnedAt || referral.appliedAt || '',
        status: referral.status
      });
    }
    referralActivity.sort((a, b) => Date.parse(b.submittedAt || 0) - Date.parse(a.submittedAt || 0));
    const pendingReferrals = referralActivity.filter(item =>
      ['email_verification_pending', 'email_delivery_failed', 'verified_pending_admin'].includes(item.status)
    ).length;
    const pendingMonths = referrals.filter(item => item.status === 'earned').reduce((sum, item) => sum + (item.rewardMonths || 1), 0);
    const appliedMonths = referrals.filter(item => item.status === 'applied').reduce((sum, item) => sum + (item.rewardMonths || 1), 0);
    const link = new WebURL('/?ref=' + encodeURIComponent(customer.referralCode) + '#client-portal', siteBase).href;
    const activeContests = contests.filter(item => Date.parse(item.startAt) <= now() && Date.parse(item.endAt) >= now())
      .map(contest => ({
        id: contest.id,
        name: contest.name,
        startAt: contest.startAt,
        endAt: contest.endAt,
        referrals: allReferrals.filter(item =>
          item.referrerId === customer.id &&
          ['earned', 'applied'].includes(item.status) &&
          Date.parse(item.earnedAt) >= Date.parse(contest.startAt) &&
          Date.parse(item.earnedAt) <= Date.parse(contest.endAt)
        ).length
      }));
    return json(200, {
      name: customer.name,
      email: customer.email,
      referralCode: customer.referralCode,
      referralLink: link,
      pendingReferrals,
      approvedReferrals: referrals.filter(item => ['earned', 'applied'].includes(item.status)).length,
      referralActivity,
      pendingMonths,
      appliedMonths,
      activeContests
    });
  }

  async function adminData(request) {
    if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' });
    if (!await adminAuthorized(request)) return json(401, { error: 'Open your secure business admin link to continue.' });
    const [customers, referrals, contests] = await Promise.all([
      listRecords('customers/'),
      listRecords('referrals/'),
      listRecords('contests/')
    ]);
    const activeCustomers = customers.filter(customer => customer.status === 'active');
    const counts = new Map();
    const months = new Map();
    for (const referral of referrals) {
      if (!['earned', 'applied'].includes(referral.status)) continue;
      counts.set(referral.referrerId, (counts.get(referral.referrerId) || 0) + 1);
      const totals = months.get(referral.referrerId) || { pending: 0, applied: 0 };
      const credit = referral.rewardMonths || 1;
      if (referral.status === 'applied') totals.applied += credit;
      else totals.pending += credit;
      months.set(referral.referrerId, totals);
    }
    const leaderboard = activeCustomers.map(customer => ({
      name: customer.name,
      email: customer.email,
      referralCode: customer.referralCode,
      referrals: counts.get(customer.id) || 0,
      pendingMonths: months.get(customer.id)?.pending || 0,
      appliedMonths: months.get(customer.id)?.applied || 0
    })).sort((a, b) => b.referrals - a.referrals || a.name.localeCompare(b.name));
    return json(200, {
      totals: {
        activeClients: activeCustomers.length,
        approvedReferrals: referrals.filter(item => ['earned', 'applied'].includes(item.status)).length,
        pendingMonths: [...months.values()].reduce((sum, value) => sum + value.pending, 0),
        appliedMonths: [...months.values()].reduce((sum, value) => sum + value.applied, 0)
      },
      leaderboard,
      contests: contests.sort((a, b) => b.startAt.localeCompare(a.startAt)).slice(0, 50)
    });
  }

  async function createContest(request) {
    if (request.method !== 'POST') return json(405, { error: 'Use the contest form in the secure admin page.' });
    if (!await adminAuthorized(request)) return json(401, { error: 'Open your secure business admin link to continue.' });
    let input;
    try { input = await parseBody(request); } catch { return json(400, { error: 'Enter a contest name and date range.' }); }
    const name = typeof input?.name === 'string' ? input.name.trim() : '';
    const startTime = typeof input?.startAt === 'string' ? Date.parse(input.startAt) : NaN;
    const endTime = typeof input?.endAt === 'string' ? Date.parse(input.endAt) : NaN;
    if (name.length < 2 || name.length > 80 || !Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime) {
      return json(400, { error: 'Enter a contest name and a valid end date after its start date.' });
    }
    if (endTime - startTime > 366 * 24 * 60 * 60 * 1000) return json(400, { error: 'A contest can be up to one year long.' });
    const contests = await listRecords('contests/');
    if (contests.length >= 50) return json(409, { error: 'The contest history is full. Archive an older contest before adding another.' });
    const id = randomBytes(16).toString('hex');
    const contest = {
      id,
      name,
      startAt: new Date(startTime).toISOString(),
      endAt: new Date(endTime).toISOString(),
      createdAt: new Date(now()).toISOString()
    };
    await write('contests/' + id, contest);
    return json(201, { contest });
  }

  async function contestResults(request) {
    if (request.method !== 'GET') return json(405, { error: 'Method not allowed.' });
    if (!await adminAuthorized(request)) return json(401, { error: 'Open your secure business admin link to continue.' });
    const id = new WebURL(request.url).searchParams.get('id') || '';
    if (!validContestId(id)) return json(400, { error: 'Choose a valid contest.' });
    const contest = await read('contests/' + id);
    if (!contest) return json(404, { error: 'This contest was not found.' });
    const [customers, referrals] = await Promise.all([
      listRecords('customers/'),
      listRecords('referrals/')
    ]);
    const counts = new Map();
    for (const referral of referrals) {
      const earnedAt = Date.parse(referral.earnedAt);
      if (['earned', 'applied'].includes(referral.status) && earnedAt >= Date.parse(contest.startAt) && earnedAt <= Date.parse(contest.endAt)) {
        counts.set(referral.referrerId, (counts.get(referral.referrerId) || 0) + 1);
      }
    }
    const leaderboard = customers.filter(customer => customer.status === 'active')
      .map(customer => ({
        name: customer.name,
        email: customer.email,
        referralCode: customer.referralCode,
        referrals: counts.get(customer.id) || 0
      }))
      .filter(item => item.referrals > 0)
      .sort((a, b) => b.referrals - a.referrals || a.name.localeCompare(b.name));
    return json(200, { contest, leaderboard });
  }

  async function reviewInfo(request) {
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' });
    let input;
    try { input = await parseBody(request); } catch { return json(400, { error: 'This review link is invalid.' }); }
    if (!validToken(input?.token)) return json(400, { error: 'This review link is invalid.' });
    const reviewKey = 'reviews/' + hash(input.token);
    const review = await read(reviewKey);
    if (!review || review.expiresAt <= now()) return json(410, { error: 'This review link expired or was already used.' });
    const requestRecord = await read(review.requestKey);
    if (!requestRecord || requestRecord.status !== 'verified_pending_admin') return json(410, { error: 'This request is no longer awaiting review.' });
    const referrer = requestRecord.referrerId ? await read('customers/' + requestRecord.referrerId) : null;
    return json(200, {
      name: requestRecord.name,
      email: requestRecord.email,
      referralCode: requestRecord.referralCode,
      referrerName: referrer?.name || '',
      referrerEmail: referrer?.email || '',
      verifiedAt: requestRecord.verifiedAt
    });
  }

  async function reviewDecision(request) {
    if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' });
    let input;
    try { input = await parseBody(request); } catch { return json(400, { error: 'This review request is invalid.' }); }
    if (!validToken(input?.token) || !['approve', 'reject'].includes(input?.decision)) {
      return json(400, { error: 'Choose approve or reject using a valid review link.' });
    }
    const reviewKey = 'reviews/' + hash(input.token);
    const review = await read(reviewKey);
    if (!review || review.expiresAt <= now()) return json(410, { error: 'This review link expired or was already used.' });
    const requestRecord = await read(review.requestKey);
    if (!requestRecord || requestRecord.status !== 'verified_pending_admin') return json(410, { error: 'This request is no longer awaiting review.' });
    if (input.decision === 'reject') {
      await write(review.requestKey, { ...requestRecord, status: 'rejected', reviewedAt: new Date(now()).toISOString() });
      await store.delete(reviewKey);
      try {
        const contactUrl = 'https://wa.me/message/OW6W63FGRLMHJ1';
        await sendMail({
          from: env.RESEND_FROM_EMAIL.trim(),
          to: [requestRecord.email],
          subject: 'BIOHAZARDTVUSA customer portal request update',
          text: 'We could not approve your customer portal access request at this time. If you believe this is an error, contact BIOHAZARDTVUSA through WhatsApp: ' + contactUrl,
          html: '<!doctype html><html lang="en"><body style="margin:0;background:#0b0c10;color:#f7f1e5;font:16px/1.6 Arial,sans-serif;padding:32px 16px"><main style="max-width:560px;margin:auto;padding:28px;background:#16171d;border:1px solid #35302a;border-radius:14px"><h1 style="color:#e6bd62">Portal request update</h1><p>We could not approve your customer portal access request at this time. If you believe this is an error, contact BIOHAZARDTVUSA through WhatsApp.</p><p><a href="' +
            contactUrl + '" style="display:inline-block;padding:14px 20px;background:#e6bd62;color:#151515;text-decoration:none;font-weight:bold;border-radius:8px">Contact us on WhatsApp</a></p></main></body></html>'
        });
      } catch {}
      return json(200, { message: 'The customer account request was declined.' });
    }
    if (input.confirmActiveCustomer !== true) return json(400, { error: 'Confirm that the Xstream account is set up and this person is an active customer before approving access.' });
    if (requestRecord.referrerId && input.confirmNewClient !== true) {
      return json(400, { error: 'Confirm that this is a new client before awarding the referral month.' });
    }
    if (requestRecord.referrerId && input.confirmRewardApplied !== true) {
      return json(400, { error: 'Confirm that you extended the referring client’s subscription by one month in Xstream.' });
    }
    let referrer = null;
    if (requestRecord.referrerId) {
      referrer = await read('customers/' + requestRecord.referrerId);
      const codeIndex = requestRecord.referralCode ? await read('referral-codes/' + requestRecord.referralCode) : null;
      if (!referrer || referrer.status !== 'active' || codeIndex?.customerId !== referrer.id) {
        return json(409, { error: 'The referring customer is no longer active. Contact them before approving this referral.' });
      }
    }
    const customerId = hash(requestRecord.email);
    const customerKey = 'customers/' + customerId;
    let customer = await read(customerKey);
    if (customer && customer.approvedRequestId !== requestRecord.id) {
      return json(409, { error: 'An account already exists for this email address.' });
    }
    if (!customer) {
      let referralCode = '';
      for (let attempt = 0; attempt < 32; attempt++) {
        const candidate = 'BHTV-' + hash(requestRecord.id + ':' + attempt).slice(0, 10).toUpperCase();
        const codeRecord = await read('referral-codes/' + candidate);
        if (!codeRecord || codeRecord.customerId === customerId) {
          referralCode = candidate;
          break;
        }
      }
      if (!referralCode) return json(503, { error: 'A referral code could not be generated. Please try again.' });
      customer = {
        id: customerId,
        email: requestRecord.email,
        name: requestRecord.name,
        status: 'active',
        referralCode,
        ...(requestRecord.passwordHash && requestRecord.passwordSalt
          ? { passwordHash: requestRecord.passwordHash, passwordSalt: requestRecord.passwordSalt }
          : {}),
        approvedRequestId: requestRecord.id,
        approvedAt: new Date(now()).toISOString()
      };
      await write(customerKey, customer);
    }
    const existingCodeIndex = await read('referral-codes/' + customer.referralCode);
    if (existingCodeIndex && existingCodeIndex.customerId !== customer.id) {
      return json(409, { error: 'This customer referral code is already assigned. Contact support before approving.' });
    }
    await write('referral-codes/' + customer.referralCode, { customerId: customer.id });
    if (requestRecord.referrerId) {
      const referralKey = 'referrals/' + referrer.id + '/' + customer.id;
      if (!await read(referralKey)) {
        await write(referralKey, {
          referrerId: referrer.id,
          referredCustomerId: customer.id,
          status: 'applied',
          rewardMonths: 1,
          earnedAt: new Date(now()).toISOString(),
          appliedAt: new Date(now()).toISOString()
        });
      }
    }
    await write(review.requestKey, { ...requestRecord, status: 'approved', approvedAt: new Date(now()).toISOString() });
    await store.delete(reviewKey);
    let notificationSent = true;
    try {
      const url = new WebURL('/#client-portal', siteBase).href;
      const signInInstructions = customer.passwordHash
        ? 'Sign in on the BIOHAZARDTVUSA homepage using the email address and password you chose.'
        : 'Use Password help on the homepage to set a password with a secure email link.';
      await sendMail({
        from: env.RESEND_FROM_EMAIL.trim(),
        to: [customer.email],
        subject: 'Your BIOHAZARDTVUSA customer portal is ready',
        text: 'Your customer portal access is approved. ' + signInInstructions + '\n\nOpen the homepage here:\n' + url,
        html: '<!doctype html><html lang="en"><body style="margin:0;background:#0b0c10;color:#f7f1e5;font:16px/1.6 Arial,sans-serif;padding:32px 16px"><main style="max-width:560px;margin:auto;padding:28px;background:#16171d;border:1px solid #35302a;border-radius:14px"><h1 style="color:#e6bd62">Portal access approved</h1><p>Your BIOHAZARDTVUSA customer portal is ready. ' +
          escapeHtml(signInInstructions) + '</p><p><a href="' +
          escapeHtml(url) + '" style="display:inline-block;padding:14px 20px;background:#e6bd62;color:#151515;text-decoration:none;font-weight:bold;border-radius:8px">Open the homepage</a></p></main></body></html>'
      });
    } catch { notificationSent = false; }
    return json(200, {
      message: notificationSent ? 'Customer access approved.' : 'Customer access approved, but the email notice could not be sent.',
      notificationSent
    });
  }

  return async request => {
    try {
      const url = new WebURL(request.url);
      const action = url.searchParams.get('action') || '';
      if (request.method === 'POST') {
        const origin = request.headers.get('origin');
        if (origin && origin !== url.origin) return json(403, { error: 'Please use the customer portal on our website.' });
      }
      if (action === 'request-account') return await accountRequest(request);
      if (action === 'verify-account') return await verifyAccount(request);
      if (action === 'request-login') return await requestLogin(request);
      if (action === 'consume-login') return await consumeLogin(request);
      if (action === 'password-login') return await passwordLogin(request);
      if (action === 'password-reset-request') return await requestPasswordReset(request);
      if (action === 'password-reset') return await consumePasswordReset(request);
      if (action === 'profile') return await profile(request);
      if (action === 'admin-data') return await adminData(request);
      if (action === 'contest-create') return await createContest(request);
      if (action === 'contest-results') return await contestResults(request);
      if (action === 'logout') {
        if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' });
        const token = getSessionToken(request);
        if (validToken(token)) await store.delete('sessions/' + hash(token));
        return json(200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });
      }
      if (action === 'review-info' || action === 'review-decision') {
        if (!await limited('review-ip', request.headers.get('x-nf-client-connection-ip') || 'unknown', 20)) {
          return action === 'review-info' ? await reviewInfo(request) : await reviewDecision(request);
        }
        return json(429, { error: 'Please wait before reviewing another request.' });
      }
      return json(404, { error: 'This customer portal action was not found.' });
    } catch {
      return json(503, { error: 'The customer portal is temporarily unavailable. Please try again later.' });
    }
  };
}
