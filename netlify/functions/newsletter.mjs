import { getStore } from '@netlify/blobs';
import { createNewsletterHandler } from '../lib/newsletter-core.mjs';

export default async request => {
  const store = getStore({ name: 'biohazard-email-signups', consistency: 'strong' });
  const handler = createNewsletterHandler({
    store,
    env: process.env,
    sendMail: async message => {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify(message)
      });
      if (!response.ok) throw new Error('Admin access email was not accepted.');
    },
    sendCampaignBatch: async (messages, idempotencyKey) => {
      const response = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + process.env.RESEND_API_KEY,
          'content-type': 'application/json',
          'Idempotency-Key': idempotencyKey
        },
        body: JSON.stringify(messages)
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error('Resend did not accept the campaign batch.');
      return result;
    }
  });
  return handler(request);
};
