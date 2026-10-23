import { getStore } from '@netlify/blobs';
import { createHash } from 'node:crypto';

const store = getStore('biohazard-review-moderation');
const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

async function findReview(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const key = 'action-' + tokenHash(token);
  const id = await store.get(key, { type: 'text' });
  if (!id) return null;
  const reviewKey = 'review-' + id;
  const review = await store.get(reviewKey, { type: 'json' });
  if (!review || review.status !== 'pending' || review.actionExpiresAt < Date.now()) return null;
  return { key, reviewKey, review };
}

export default async (request) => {
  const url = new URL(request.url);
  if (request.method === 'GET') {
    try {
      const found = await findReview(url.searchParams.get('token'));
      if (!found) return json(404, { error: 'This approval link is invalid, expired, or already used.' });
      return json(200, { review: { name: found.review.name, review: found.review.review, createdAt: found.review.createdAt } });
    } catch { return json(503, { error: 'Review details are temporarily unavailable.' }); }
  }
  if (request.method !== 'POST') return json(405, { error: 'Method not allowed.' });
  let input;
  try { input = await request.json(); } catch { return json(400, { error: 'Invalid approval request.' }); }
  if (!['approve', 'reject'].includes(input.decision)) return json(400, { error: 'Choose approve or reject.' });
  try {
    const found = await findReview(input.token);
    if (!found) return json(404, { error: 'This approval link is invalid, expired, or already used.' });
    found.review.status = input.decision === 'approve' ? 'approved' : 'rejected';
    found.review.decidedAt = new Date().toISOString();
    delete found.review.actionTokenHash;
    delete found.review.actionExpiresAt;
    await store.set(found.reviewKey, JSON.stringify(found.review));
    await store.delete(found.key);
    return json(200, { ok: true, status: found.review.status });
  } catch { return json(503, { error: 'We could not save that decision. Please try again.' }); }
};