import { createHash, randomBytes } from 'node:crypto';
import { URL as WebURL } from 'node:url';

const CONSENT = 'Yes, email me BIOHAZARDTVUSA live TV updates, offers and referral news. I can unsubscribe at any time.';
const VERSION = '2026-10-25';
const STATES = new Set(('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY OTHER OUTSIDE_US UNSPECIFIED').split(' '));
const hash = value => createHash('sha256').update(value).digest('hex');
const keyFor = email => 'subscribers/' + hash(email);
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
        if (record?.status === 'active') records.push(record);
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
      if (request.method === 'POST') {
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
        const accessUrl = new WebURL('/email-list.html', env.URL || 'https://biohazardtvusa.netlify.app/');
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

      if (['summary', 'export', 'unsubscribe'].includes(action)) {
        if (!await authorized(request)) return json(401, { error: 'This link is missing or expired. Request a new secure access email.' });
        if (action === 'unsubscribe' && request.method === 'POST') {
          let input;
          try { input = await parse(request); } catch { return json(400, { error: 'Enter the email address to unsubscribe.' }); }
          const email = String(input.email || '').trim().toLowerCase();
          if (!email || email.length > 254) return json(400, { error: 'Enter a valid email address.' });
          const key = keyFor(email);
          const record = await read(key);
          if (record) await write(key, { ...record, status: 'unsubscribed', unsubscribedAt: new Date(now()).toISOString() });
          return json(200, { message: 'This address is excluded from future email-list exports.' });
        }
        if (request.method !== 'GET' || action === 'unsubscribe') return json(405, { error: 'Method not allowed.' });
        const rows = await subscribers();
        if (action === 'summary') return json(200, {
          active: rows.length, texas: rows.filter(row => row.state === 'TX').length,
          other: rows.filter(row => row.state !== 'TX').length
        });
        const columns = ['Email', 'First name', 'State', 'Marketing consent date', 'Consent text', 'Consent version', 'Source', 'Email ownership verified'];
        const lines = rows.map(row => [row.email, row.firstName, row.state, row.consentedAt, row.consentText, row.consentVersion, row.source, 'No']);
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
      // Existing active signups are not overwritten by a repeated public request.
      if (!prior || prior.status !== 'active') {
        await write(key, {
          email, firstName, state, status: 'active',
          createdAt: prior?.createdAt || new Date(now()).toISOString(),
          consentedAt: new Date(now()).toISOString(), consentText: CONSENT,
          consentVersion: VERSION, source: 'website-email-updates', emailOwnershipVerified: false
        });
      }
      if ((request.headers.get('accept') || '').includes('text/html')) {
        return new Response('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signup saved | BIOHAZARDTVUSA</title><body><h1>Your signup is saved.</h1><p>You have joined the BIOHAZARDTVUSA email update list. No purchase or payment is required.</p><p><a href="/#email-updates">Return to BIOHAZARDTVUSA</a></p></body></html>', { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
      }
      return json(200, { message: 'You’re on the list! Your signup is saved. Watch your inbox for future BIOHAZARDTVUSA updates.' });
    } catch {
      console.error('newsletter_request_failed');
      return json(503, { error: 'We could not save or retrieve this request. Please try again later.' });
    }
  };
}
