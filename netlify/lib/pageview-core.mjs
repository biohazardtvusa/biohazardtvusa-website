import { createHash, randomBytes } from 'node:crypto';

const SOURCES = new Set([
  'google', 'bing', 'facebook', 'instagram', 'tiktok', 'youtube', 'whatsapp',
  'email', 'client_referral', 'direct', 'other_website', 'other', 'unknown'
]);
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 90;
const PAGEVIEWS_PER_IP_PER_HOUR = 60;

function response(status, body = null, headers = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      ...(body === null ? {} : { 'content-type': 'application/json; charset=utf-8' }),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-robots-tag': 'noindex',
      ...headers
    }
  });
}

export function createPageviewHandler({ store, now = () => Date.now(), makeId = () => randomBytes(16).toString('hex') }) {
  async function pruneOldPageviews(today) {
    const markerKey = 'maintenance/pageviews-cleanup';
    const marker = await store.get(markerKey, { type: 'json' });
    if (marker?.day >= today) return;

    const cutoff = new Date(now() - RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);
    for (const { prefix, dayIndex, keepFrom } of [
      { prefix: 'pageviews/', dayIndex: 1, keepFrom: cutoff },
      { prefix: 'limits/pageviews/', dayIndex: 2, keepFrom: today }
    ]) {
      for await (const page of store.list({ prefix, paginate: true })) {
        for (const blob of page.blobs) {
          const day = blob.key.split('/')[dayIndex] || '';
          if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < keepFrom) {
            await store.delete(blob.key);
          }
        }
      }
    }
    await store.setJSON(markerKey, { day: today });
  }

  return async request => {
    if (request.method !== 'POST') return response(405, { error: 'Method not allowed.' });

    let requestUrl;
    let originUrl;
    try {
      requestUrl = new URL(request.url);
      originUrl = new URL(request.headers.get('origin') || '');
    } catch {
      return response(403, { error: 'Please use the website to record a page view.' });
    }
    if (originUrl.origin !== requestUrl.origin) {
      return response(403, { error: 'Please use the website to record a page view.' });
    }
    if (!(request.headers.get('content-type') || '').toLowerCase().includes('application/json')) {
      return response(400, { error: 'Invalid page-view request.' });
    }

    let input;
    try {
      if (Number(request.headers.get('content-length')) > 2048) throw new Error('too large');
      const text = await request.text();
      if (text.length > 2048) throw new Error('too large');
      input = JSON.parse(text);
    } catch {
      return response(400, { error: 'Invalid page-view request.' });
    }

    if (!input || typeof input !== 'object' || Array.isArray(input) || input.page !== '/') {
      return response(400, { error: 'Invalid page-view request.' });
    }
    const requestedSource = typeof input.source === 'string' ? input.source.toLowerCase() : 'unknown';
    const source = SOURCES.has(requestedSource) ? requestedSource : 'unknown';
    const campaign = typeof input.campaign === 'string'
      ? input.campaign.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48)
      : '';
    const timestamp = now();
    const createdAt = new Date(timestamp).toISOString();
    const day = createdAt.slice(0, 10);
    const hour = Math.floor(timestamp / 3600000);
    const ip = (request.headers.get('x-nf-client-connection-ip') || 'unknown').slice(0, 64);
    const ipHash = createHash('sha256').update(ip + ':' + hour).digest('hex');
    const limitKey = 'limits/pageviews/' + day + '/' + hour + '/' + ipHash;

    try {
      const priorLimit = await store.get(limitKey, { type: 'json' });
      if ((priorLimit?.count || 0) >= PAGEVIEWS_PER_IP_PER_HOUR) {
        return response(429, { error: 'Too many page views were submitted. Please try again later.' }, {
          'retry-after': '3600'
        });
      }
      await store.setJSON(limitKey, { count: (priorLimit?.count || 0) + 1 });
      await store.setJSON('pageviews/' + day + '/' + makeId(), {
        page: '/',
        source,
        campaign,
        createdAt
      });
      try {
        await pruneOldPageviews(day);
      } catch {
        // Keep the page-view request successful if retention cleanup is temporarily unavailable.
      }
      return response(204);
    } catch {
      return response(503, { error: 'Page-view tracking is temporarily unavailable.' });
    }
  };
}
