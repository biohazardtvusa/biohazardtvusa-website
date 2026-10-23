import { getStore } from '@netlify/blobs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const store = getStore('biohazard-review-moderation');
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] || '&#39;'));

export default async (request) => {
  if (request.method === 'GET') {
    try {
      const { blobs = [] } = await store.list({ prefix: 'review-' });
      const records = await Promise.all(blobs.map((blob) => store.get(blob.key, { type: 'json' })));
      const reviews = records.filter((item) => item && item.status === 'approved').map(({ name, review, createdAt }) => ({ name, review, createdAt })).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
      return json(200, { reviews });
    } catch {
      return json(503, { error: 'Approved reviews are temporarily unavailable.' });
    }
  }

  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  let input;
  try { input = await request.json(); } catch { return json(400, { error: 'Please submit a valid review.' }); }
  if (typeof input.website === 'string' && input.website.trim()) return json(200, { ok: true, message: 'Thanks for your submission.' });
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 70) : '';
  const review = typeof input.review === 'string' ? input.review.trim().slice(0, 1500) : '';
  if (name.length < 1 || review.length < 5 || input.consent !== true) return json(400, { error: 'Add your name, a review, and consent to public display if approved.' });

  const { RESEND_API_KEY, RESEND_FROM_EMAIL, REVIEW_ADMIN_EMAIL, URL, DEPLOY_PRIME_URL } = process.env;
  const siteUrl = URL || DEPLOY_PRIME_URL;
  if (!RESEND_API_KEY || !RESEND_FROM_EMAIL || !REVIEW_ADMIN_EMAIL || !siteUrl) return json(503, { error: 'Review email is not configured yet. Please contact us through WhatsApp for now.' });

  const id = randomUUID();
  const token = randomBytes(32).toString('hex');
  const tokenHash = hash(token);
  const createdAt = new Date().toISOString();
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  const reviewKey = 'review-' + id;
  const actionKey = 'action-' + tokenHash;
  const actionPage = new URL('/review-approval.html', siteUrl);
  const approveUrl = new URL(actionPage);
  approveUrl.searchParams.set('token', token);
  approveUrl.searchParams.set('decision', 'approve');
  const rejectUrl = new URL(actionPage);
  rejectUrl.searchParams.set('token', token);
  rejectUrl.searchParams.set('decision', 'reject');
  const safeName = escapeHtml(name);
  const safeReview = escapeHtml(review).replace(/\n/g, '<br>');
  const text = 'New BiohazardTvUSA review awaiting approval.\n\nName: ' + name + '\nReview: ' + review + '\n\nApprove: ' + approveUrl.href + '\nReject: ' + rejectUrl.href + '\n\nLinks expire in 7 days and require a confirmation click.';
  const html = '<h2>New review awaiting approval</h2><p><strong>Name:</strong> ' + safeName + '</p><p><strong>Review:</strong><br>' + safeReview + '</p><p><a href="' + approveUrl.href + '">Review and approve</a></p><p><a href="' + rejectUrl.href + '">Review and reject</a></p><p>These links expire in 7 days. Opening a link does not approve or reject until you confirm.</p>';

  try {
    await store.set(reviewKey, JSON.stringify({ id, name, review, status: 'pending', createdAt, actionTokenHash: tokenHash, actionExpiresAt: expiresAt }));
    await store.set(actionKey, id);
    const mail = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + RESEND_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ from: RESEND_FROM_EMAIL, to: [REVIEW_ADMIN_EMAIL], subject: 'Review awaiting your approval', text, html })
    });
    if (!mail.ok) {
      await store.delete(reviewKey);
      await store.delete(actionKey);
      return json(502, { error: 'We could not send the approval email. Please try again or contact us through WhatsApp.' });
    }
    return json(201, { ok: true, message: 'Thanks—your review was sent for approval. It will appear on the site only if approved.' });
  } catch {
    try { await store.delete(reviewKey); await store.delete(actionKey); } catch {}
    return json(502, { error: 'We could not send the approval email. Please try again or contact us through WhatsApp.' });
  }
};