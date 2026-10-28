import { getStore } from '@netlify/blobs';
import { createCustomerPortalHandler } from '../lib/customer-portal-core.mjs';

const store = getStore({ name: 'biohazard-customer-portal', consistency: 'strong' });

export default async request => {
  const handler = createCustomerPortalHandler({
    store,
    env: process.env,
    sendMail: async message => {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + process.env.RESEND_API_KEY,
          'content-type': 'application/json'
        },
        body: JSON.stringify(message)
      });
      if (!response.ok) throw new Error('Email could not be sent.');
    }
  });
  return handler(request);
};
