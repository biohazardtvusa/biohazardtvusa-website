import { getStore } from '@netlify/blobs';
import { createContactHandler } from '../lib/contact-core.mjs';

const store = getStore({ name: 'biohazard-contact-rate-limits', consistency: 'strong' });
const handler = createContactHandler({
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
    if (!response.ok) {
      console.error('contact_email_failed', JSON.stringify({ httpStatus: response.status }));
      throw new Error('Email delivery failed.');
    }
  }
});

export default request => handler(request);
