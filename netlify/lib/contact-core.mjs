import { createHash } from 'node:crypto';

const MAX_BODY_BYTES = 12_000;
const MAX_SUBMISSIONS_PER_HOUR = 5;
const FALLBACK_EMAIL = 'Biohazardtvusa@gmail.com';

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-robots-tag': 'noindex'
  }
});

const hash = value => createHash('sha256').update(value).digest('hex');
const singleLine = value => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  : '';
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);

export function createContactHandler({ store, env = {}, sendMail, now = () => Date.now() }) {
  async function limited(request) {
    const ip = request.headers.get('x-nf-client-connection-ip') || 'unknown';
    const hour = Math.floor(now() / 3_600_000);
    const key = 'limits/' + hash(ip + ':' + hour);
    const current = await store.get(key, { type: 'json' });
    if ((current?.count || 0) >= MAX_SUBMISSIONS_PER_HOUR) return true;
    await store.setJSON(key, { count: (current?.count || 0) + 1 });
    return false;
  }

  return async request => {
    if (request.method !== 'POST') {
      return json(405, { error: 'Method not allowed.' });
    }

    const origin = request.headers.get('origin');
    if (origin) {
      try {
        if (new URL(origin).origin !== new URL(request.url).origin) {
          return json(403, { error: 'Please use the contact form on our website.' });
        }
      } catch {
        return json(403, { error: 'Please use the contact form on our website.' });
      }
    }

    if (!(request.headers.get('content-type') || '').includes('application/json')) {
      return json(415, { error: 'Please submit the contact form again.' });
    }

    const declaredLength = Number(request.headers.get('content-length') || 0);
    if (declaredLength > MAX_BODY_BYTES) return json(413, { error: 'Your message is too long.' });

    let raw;
    try {
      raw = await request.text();
    } catch {
      return json(400, { error: 'Please submit a valid message.' });
    }
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return json(413, { error: 'Your message is too long.' });
    }

    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      return json(400, { error: 'Please submit a valid message.' });
    }

    // Silently accept filled honeypots so simple bots do not learn the field name.
    if (typeof input?.website === 'string' && input.website.trim()) {
      return json(200, { ok: true, message: 'Thanks—your message was received.' });
    }

    const name = singleLine(input?.name);
    const email = singleLine(input?.email).toLowerCase();
    const phone = singleLine(input?.phone);
    const message = typeof input?.message === 'string'
      ? input.message.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim()
      : '';

    if (!name || name.length > 70) return json(400, { error: 'Please enter a name of 70 characters or fewer.' });
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return json(400, { error: 'Please enter a valid email address.' });
    }
    if (phone.length > 40) return json(400, { error: 'Please shorten the phone number.' });
    if (message.length > 4000) return json(400, { error: 'Please shorten your message to 4,000 characters or fewer.' });
    if (message.length < 2) return json(400, { error: 'Please enter a message.' });

    const recipient = (env.CONTACT_ADMIN_EMAIL || env.REVIEW_ADMIN_EMAIL || '').trim();
    if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL || !recipient) {
      return json(503, {
        error: 'The contact form is temporarily unavailable. Please email ' + FALLBACK_EMAIL + ' or use WhatsApp.'
      });
    }

    try {
      if (await limited(request)) return json(429, { error: 'Please wait before sending another message.' });
    } catch {
      return json(503, {
        error: 'The contact form is temporarily unavailable. Please email ' + FALLBACK_EMAIL + ' or use WhatsApp.'
      });
    }

    const safeName = escapeHtml(name);
    const safeEmail = escapeHtml(email);
    const safePhone = escapeHtml(phone || 'Not provided');
    const safeMessage = escapeHtml(message).replace(/\n/g, '<br>');
    const text = [
      'New BIOHAZARDTVUSA website contact message',
      '',
      'Name: ' + name,
      'Email: ' + email,
      'Phone: ' + (phone || 'Not provided'),
      '',
      'Message:',
      message
    ].join('\n');
    const html = '<h2>New website contact message</h2>' +
      '<p><strong>Name:</strong> ' + safeName + '</p>' +
      '<p><strong>Email:</strong> ' + safeEmail + '</p>' +
      '<p><strong>Phone:</strong> ' + safePhone + '</p>' +
      '<p><strong>Message:</strong><br>' + safeMessage + '</p>';

    try {
      await sendMail({
        from: env.RESEND_FROM_EMAIL.trim(),
        to: [recipient],
        reply_to: email,
        subject: 'Website contact from ' + name,
        text,
        html
      });
    } catch {
      return json(502, {
        error: 'We could not send your message. Please email ' + FALLBACK_EMAIL + ' or use WhatsApp.'
      });
    }

    return json(200, { ok: true, message: 'Thanks—your message was sent. We’ll reply to your email.' });
  };
}
