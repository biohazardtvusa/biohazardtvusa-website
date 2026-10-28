import { getStore } from '@netlify/blobs';
import { createContactHandler } from '../lib/contact-core.mjs';

const store = getStore({ name: 'biohazard-contact-rate-limits', consistency: 'strong' });
const handler = createContactHandler({
  store,
  env: process.env,
  sendMail: async message => {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + process.env.RESEND_API_KEY,
          'content-type': 'application/json'
        },
        body: JSON.stringify(message)
      });
      if (response.ok) return;

      let provider = {};
      try {
        provider = await response.json();
      } catch {}
      const providerMessage = typeof provider.message === 'string'
        ? provider.message
        : typeof provider.error?.message === 'string' ? provider.error.message : '';
      let reason = 'provider_rejected';
      if (/testing emails|only send.*own|test.*own email/i.test(providerMessage)) reason = 'test_sender_recipient_restriction';
      else if (/domain.*not verified/i.test(providerMessage)) reason = 'sender_domain_unverified';
      else if (/invalid.*api.?key|api.?key.*invalid/i.test(providerMessage)) reason = 'invalid_api_key';
      else if (/from.*invalid|invalid.*from/i.test(providerMessage)) reason = 'invalid_sender';
      else if (/quota|rate limit|credits|daily limit/i.test(providerMessage)) reason = 'sending_limit';

      console.error('contact_email_failed', JSON.stringify({
        httpStatus: response.status,
        reason,
        testSenderConfigured: process.env.RESEND_FROM_EMAIL?.trim().toLowerCase() === 'onboarding@resend.dev'
      }));
      const error = new Error('Email provider rejected the message.');
      error.contactReason = reason;
      throw error;
    } catch (cause) {
      if (cause?.contactReason) throw cause;
      console.error('contact_email_failed', JSON.stringify({ reason: 'network_error' }));
      const error = new Error('Email provider request failed.');
      error.contactReason = 'network_error';
      throw error;
    }
  }
});

export default request => handler(request);
