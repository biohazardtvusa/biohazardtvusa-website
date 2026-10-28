import { createHash, randomBytes } from 'node:crypto';
import { URL as WebURL } from 'node:url';

const CONSENT = 'Yes, email me BIOHAZARDTVUSA live TV updates, offers and referral news. I can unsubscribe at any time.';
const VERSION = '2026-10-28';
const CONFIRMATION_TTL_MS = 72 * 60 * 60 * 1000;
const CONFIRMATION_RESEND_MS = 10 * 60 * 1000;
const STATES = new Set(('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY OTHER OUTSIDE_US UNSPECIFIED').split(' '));
const hash = value => createHash('sha256').update(value).digest('hex');
const keyFor = email => 'subscribers/' + hash(email);
const confirmationKeyFor = tokenHash => 'confirmations/' + tokenHash;
const unsubscribeKeyFor = token => 'unsubscribe-tokens/' + hash(token);
const validToken = token => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
const escapeHtml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex' }
});
const csvCell = value => {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
};

export function createNewsletterHandler({ store, env = {}, sendMail, now = () => Date.now() }) {
  async function read(key) { return store.get(key, { type: 'json' }); }
  async function write(key, value) { await store.setJSON(key, value); }
  const siteBase = env.PUBLIC_SITE_URL || 'https://biohazardtvusa.com/';

  async function clearSubscriberLinks(record) {
    if (record?.confirmationTokenHash) await store.delete(confirmationKeyFor(record.confirmationTokenHash));
    if (record?.unsubscribeToken) await store.delete(unsubscribeKeyFor(record.unsubscribeToken));
  }

  async function sendConfirmation(email, token) {
    const confirmUrl = new WebURL('/email-confirmation.html', siteBase);
    confirmUrl.hash = 'token=' + token;
    const href = escapeHtml(confirmUrl.href);
    await sendMail({
      from: env.RESEND_FROM_EMAIL.trim(),
      to: [email],
      subject: 'Confirm your BIOHAZARDTVUSA email updates',
      text: 'Please confirm that you want BIOHAZARDTVUSA live TV updates, offers and referral news. Confirm your email address here:\n\n' +
        confirmUrl.href + '\n\nThis link expires in 72 hours. We will not send marketing emails until you confirm. If you did not request this, you can ignore this message.',
      html: '<!doctype html><html lang="en"><body style="margin:0;background:#0b0c10;color:#f7f1e5;font:16px/1.6 Arial,sans-serif;padding:32px 16px"><main style="max-width:560px;margin:auto;padding:28px;background:#16171d;border:1px solid #35302a;border-radius:14px"><h1 style="color:#e6bd62">BIOHAZARDTVUSA</h1><p>Please confirm that you want live TV updates, offers and referral news by email.</p><p><a href="' + href + '" style="display:inline-block;padding:14px 20px;background:#e6bd62;color:#151515;text-decoration:none;font-weight:bold;border-radius:8px">Confirm email address</a></p><p>This link expires in 72 hours. We will not send marketing emails until you confirm.</p><p>If you did not request this, ignore this email.</p></main></body></html>'
    });
  }

  async function limited(request, category, max) {
    const ip = request.headers.get('x-nf-client-connection-ip') || 'unknown';
    const key = 'limits/' + category + '/' + hash(ip + ':' + Math.floor(now() / 3600000));
    const current = await read(key);
    if ((current?.count || 0) >= max) return true;
    await write(key, { count: (current?.count || 0) + 1 });
    return false;
  }

  async function authorized(request) {
    const token = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
    if (!/^[a-f0-9]{64}$/.test(token)) return false;
    const record = await read('access/' + hash(token));
    return Boolean(record && record.expiresAt > now());
  }

  async function subscribers() {
    const records = [];
    for await (const page of store.list({ prefix: 'subscribers/', paginate: true })) {
      for (const blob of page.blobs) {
        const record = await read(blob.key);
        if (record?.status === 'active' && record.emailOwnershipVerified === true && validToken(record.unsubscribeToken)) records.push(record);
      }
    }
    return records.sort((a, b) => a.state === b.state
      ? a.consentedAt.localeCompare(b.consentedAt)
      : a.state === 'TX' ? -1 : b.state === 'TX' ? 1 : a.state.localeCompare(b.state));
  }

  async function parse(request) {
    if (Number(request.headers.get('content-length')) > 4096) throw new Error('body');
    const text = await request.text();
    if (text.length > 4096) throw new Error('body');
    if ((request.headers.get('content-type') || '').includes('application/json')) return JSON.parse(text);
    if ((request.headers.get('content-type') || '').includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
    throw new Error('body');
  }

  return async request => {
    try {
      const url = new WebURL(request.url);
      const action = url.searchParams.get('action') || 'signup';
      if (request.method === 'POST' && action !== 'one-click-unsubscribe') {
        const origin = request.headers.get('origin');
        if (origin && origin !== url.origin) return json(403, { error: 'Please use the form on our website.' });
      }

      if (action === 'health' && request.method === 'GET') {
        // Probe private persistence without creating a subscriber or sending email.
        if (await limited(request, 'health', 5)) return json(429, { error: 'Please try the storage check again later.' });
        const value = randomBytes(16).toString('hex');
        const key = 'health/' + value;
        try {
          await write(key, { value });
          const saved = await read(key);
          if (saved?.value !== value) throw new Error('Storage check failed');
        } finally {
          await store.delete(key);
        }
        return json(200, { storage: 'ready', adminEmailConfigured: Boolean(env.RESEND_API_KEY && env.RESEND_FROM_EMAIL && env.REVIEW_ADMIN_EMAIL) });
      }

      if (action === 'request-access' && request.method === 'POST') {
        if (await limited(request, 'access', 5)) return json(429, { error: 'Please wait before requesting another access email.' });
        if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL || !env.REVIEW_ADMIN_EMAIL) {
          return json(503, { error: 'Email-list access is not configured. Signups are still stored privately.' });
        }
        const prior = await read('access-email-limit');
        const day = new Date(now()).toISOString().slice(0, 10);
        if (prior?.lastSent > now() - 600000) return json(202, { message: 'An access email was requested recently. Check your business inbox and spam folder, or try again in 10 minutes.' });
        if (prior?.day === day && prior.count >= 10) return json(429, { error: 'The daily access-email limit was reached. Try again tomorrow.' });
        const token = randomBytes(32).toString('hex');
        const tokenKey = 'access/' + hash(token);
        const accessUrl = new WebURL('/email-list.html', siteBase);
        accessUrl.hash = 'access=' + token;
        await write(tokenKey, { expiresAt: now() + 7 * 86400000 });
        await write('access-email-limit', { day, count: prior?.day === day ? prior.count + 1 : 1, lastSent: now() });
        try {
          await sendMail({
            from: env.RESEND_FROM_EMAIL.trim(), to: [env.REVIEW_ADMIN_EMAIL.trim()],
            subject: 'Your secure BIOHAZARDTVUSA email-list access',
            text: 'Use this private link to view signup totals, download your email list, or unsubscribe an address:\n\n' + accessUrl.href +
              '\n\nThis link expires in 7 days. Do not share it; anyone with the link can manage your list.\nNo marketing campaign has been sent.'
          });
        } catch {
          await store.delete(tokenKey);
          await store.delete('access-email-limit');
          return json(503, { error: 'We could not send the access email. Please try again later. Existing signups are safe.' });
        }
        return json(202, { message: 'Access link sent to your configured business admin email. Check the inbox and spam folder. The link expires in 7 days.' });
      }

      if (action === 'confirm') {
        if (request.method !== 'POST') return json(405, { error: 'Use the confirmation button on the website.' });
        if (await limited(request, 'confirmation', 30)) return json(429, { error: 'Please wait before trying to confirm again.' });
        let input;
        try { input = await parse(request); } catch { return json(400, { error: 'This confirmation link is invalid. Submit the form again to request a new one.' }); }
        const token = input.token;
        if (!validToken(token)) return json(400, { error: 'This confirmation link is invalid. Submit the form again to request a new one.' });
        const tokenHash = hash(token);
        const tokenKey = confirmationKeyFor(tokenHash);
        const confirmation = await read(tokenKey);
        if (!confirmation || confirmation.expiresAt <= now()) {
          if (confirmation) await store.delete(tokenKey);
          return json(410, { error: 'This confirmation link has expired. Submit the form again to request a new one.' });
        }
        const record = await read(confirmation.subscriberKey);
        if (record?.status === 'active' && record.emailOwnershipVerified === true) {
          if (!confirmation.usedAt) await write(tokenKey, { ...confirmation, usedAt: now() });
          return json(200, { message: 'Your email address is confirmed. You are subscribed to BIOHAZARDTVUSA updates.' });
        }
        if (!record || record.status !== 'pending' || record.confirmationTokenHash !== tokenHash) {
          return json(410, { error: 'This confirmation link is no longer active. Submit the form again to request a new one.' });
        }
        const unsubscribeToken = randomBytes(32).toString('hex');
        await write(unsubscribeKeyFor(unsubscribeToken), { subscriberKey: confirmation.subscriberKey });
        await write(confirmation.subscriberKey, {
          ...record,
          status: 'active',
          emailOwnershipVerified: true,
          confirmedAt: new Date(now()).toISOString(),
          confirmationTokenHash: null,
          confirmationSentAt: null,
          unsubscribeToken
        });
        await write(tokenKey, { ...confirmation, usedAt: now() });
        return json(200, { message: 'Your email address is confirmed. You are subscribed to BIOHAZARDTVUSA updates. You can unsubscribe at any time.' });
      }

      if (action === 'one-click-unsubscribe') {
        if (request.method !== 'POST') return json(405, { error: 'Use the unsubscribe link in the email.' });
        const token = url.searchParams.get('token') || '';
        if (!validToken(token)) return json(400, { error: 'This unsubscribe link is invalid.' });
        const tokenKey = unsubscribeKeyFor(token);
        const mapping = await read(tokenKey);
        if (!mapping) return json(200, { message: 'This address is already unsubscribed or this link is no longer active.' });
        const record = await read(mapping.subscriberKey);
        if (record && record.status !== 'unsubscribed') {
          await clearSubscriberLinks(record);
          const { confirmationTokenHash, unsubscribeToken, ...remaining } = record;
          await write(mapping.subscriberKey, {
            ...remaining,
            status: 'unsubscribed',
            emailOwnershipVerified: false,
            unsubscribedAt: new Date(now()).toISOString()
          });
        } else {
          await store.delete(tokenKey);
        }
        return json(200, { message: 'You have been unsubscribed from BIOHAZARDTVUSA marketing emails.' });
      }

      if (['summary', 'export', 'unsubscribe'].includes(action)) {
        if (!await authorized(request)) return json(401, { error: 'This link is missing or expired. Request a new secure access email.' });
        if (action === 'unsubscribe' && request.method === 'POST') {
          let input;
          try { input = await parse(request); } catch { return json(400, { error: 'Enter the email address to unsubscribe.' }); }
          const email = String(input.email || '').trim().toLowerCase();
          if (!email || email.length > 254) return json(400, { error: 'Enter a valid email address.' });
          const key = keyFor(email);
          const record = await read(key);
          if (record) {
            await clearSubscriberLinks(record);
            const { confirmationTokenHash, unsubscribeToken, ...remaining } = record;
            await write(key, {
              ...remaining,
              status: 'unsubscribed',
              emailOwnershipVerified: false,
              unsubscribedAt: new Date(now()).toISOString()
            });
          }
          return json(200, { message: 'This address is excluded from future email-list exports.' });
        }
        if (request.method !== 'GET' || action === 'unsubscribe') return json(405, { error: 'Method not allowed.' });
        const rows = await subscribers();
        if (action === 'summary') return json(200, {
          active: rows.length, texas: rows.filter(row => row.state === 'TX').length,
          other: rows.filter(row => row.state !== 'TX').length
        });
        const columns = [
          'Email', 'First name', 'State', 'Marketing consent date', 'Consent text', 'Consent version',
          'Source', 'Email ownership verified', 'Confirmed at', 'Unsubscribe URL',
          'List-Unsubscribe header value', 'List-Unsubscribe-Post header value'
        ];
        const lines = rows.map(row => {
          const unsubscribeUrl = new WebURL('/email-unsubscribe.html', siteBase);
          unsubscribeUrl.hash = 'token=' + row.unsubscribeToken;
          const listUnsubscribeUrl = new WebURL('/.netlify/functions/newsletter', siteBase);
          listUnsubscribeUrl.searchParams.set('action', 'one-click-unsubscribe');
          listUnsubscribeUrl.searchParams.set('token', row.unsubscribeToken);
          return [
            row.email, row.firstName, row.state, row.consentedAt, row.consentText, row.consentVersion,
            row.source, 'Yes', row.confirmedAt || '', unsubscribeUrl.href,
            '<' + listUnsubscribeUrl.href + '>', 'List-Unsubscribe=One-Click'
          ];
        });
        return new Response('\uFEFF' + [columns, ...lines].map(row => row.map(csvCell).join(',')).join('\r\n'), {
          headers: {
            'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="biohazardtvusa-email-list.csv"',
            'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-robots-tag': 'noindex'
          }
        });
      }

      if (action !== 'signup' || request.method !== 'POST') return json(405, { error: 'Method not allowed.' });
      if (await limited(request, 'signup', 15)) return json(429, { error: 'Too many signup attempts. Please try again later.' });
      let input;
      try { input = await parse(request); } catch { return json(400, { error: 'Please submit the signup form again.' }); }
      if (input.website) return json(200, { message: 'Thank you for your interest.' });
      const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
      const firstName = typeof input.firstName === 'string' ? input.firstName.trim() : '';
      if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) return json(400, { error: 'Please enter a valid email address.' });
      if (firstName.length > 70 || /[\u0000-\u001f]/.test(firstName)) return json(400, { error: 'Please enter a first name of 70 characters or fewer.' });
      const state = input.state || 'UNSPECIFIED';
      if (!STATES.has(state)) return json(400, { error: 'Please choose a valid location option, or leave it unspecified.' });
      if (input.consent !== true && input.consent !== 'yes') return json(400, { error: 'Please agree to receive marketing emails before signing up.' });
      const key = keyFor(email);
      const prior = await read(key);
      const acceptedMessage = 'If your email is eligible for the list, check your inbox and spam folder for a confirmation link. If it is already confirmed, you are all set.';
      if (prior?.status === 'active' && prior.emailOwnershipVerified === true) return json(202, { message: acceptedMessage });
      if (prior?.status === 'pending' && prior.confirmationSentAt &&
          now() - Date.parse(prior.confirmationSentAt) < CONFIRMATION_RESEND_MS) {
        return json(202, { message: acceptedMessage });
      }
      if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL || typeof sendMail !== 'function') {
        return json(503, { error: 'Email confirmation is not configured. Please try again later.' });
      }
      await clearSubscriberLinks(prior);
      const token = randomBytes(32).toString('hex');
      const tokenHash = hash(token);
      const tokenKey = confirmationKeyFor(tokenHash);
      const timestamp = new Date(now()).toISOString();
      const pending = {
        email, firstName, state, status: 'pending',
        createdAt: prior?.createdAt || timestamp,
        consentedAt: timestamp,
        consentText: CONSENT,
        consentVersion: VERSION,
        source: 'website-email-updates',
        emailOwnershipVerified: false,
        confirmationTokenHash: tokenHash,
        confirmationSentAt: timestamp
      };
      await write(tokenKey, { subscriberKey: key, expiresAt: now() + CONFIRMATION_TTL_MS });
      await write(key, pending);
      try {
        await sendConfirmation(email, token);
      } catch {
        await store.delete(tokenKey);
        await write(key, { ...pending, confirmationTokenHash: null, confirmationSentAt: null });
        return json(503, { error: 'Your signup was saved, but we could not send the confirmation email. Please try again shortly.' });
      }
      if ((request.headers.get('accept') || '').includes('text/html')) {
        return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Confirm your signup | BIOHAZARDTVUSA</title><body><h1>Check your email to confirm.</h1><p>We will not send marketing updates until you confirm your email address. The link expires in 72 hours.</p><p><a href="/#email-updates">Return to BIOHAZARDTVUSA</a></p></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } });
      }
      return json(202, { message: 'Check your inbox for a confirmation link. We will not send marketing emails until you confirm.' });
    } catch {
      console.error('newsletter_request_failed');
      return json(503, { error: 'We could not save or retrieve this request. Please try again later.' });
    }
  };
}
