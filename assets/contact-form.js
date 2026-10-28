const contactForm = document.getElementById('contact-form-submit');
const contactStatus = document.getElementById('contact-status');

if (contactForm && contactStatus) {
  const attributionNote = document.createElement('p');
  attributionNote.className = 'small';
  attributionNote.append(document.createTextNode('A general source and campaign label may be included with your message to help us understand how people find the site. '));
  const privacyLink = document.createElement('a');
  privacyLink.href = '/customer-privacy.html';
  privacyLink.textContent = 'Privacy notice';
  attributionNote.append(privacyLink);
  contactForm.querySelector('button[type="submit"]')?.before(attributionNote);

  contactForm.addEventListener('submit', async event => {
    event.preventDefault();
    const submitButton = contactForm.querySelector('button[type="submit"]');
    const values = Object.fromEntries(new FormData(contactForm).entries());
    const attribution = window.biohazardAttribution || {};
    values.acquisitionSource = attribution.source || 'unknown';
    values.acquisitionCampaign = attribution.campaign || '';

    submitButton.disabled = true;
    contactStatus.textContent = 'Sending your message…';

    try {
      const response = await fetch(contactForm.action, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(values)
      });
      const result = await response.json();
      if (!response.ok) {
        const reference = result.reference ? ' (Reference: ' + result.reference + ')' : '';
        throw new Error((result.error || 'We could not send your message.') + reference);
      }
      contactStatus.textContent = result.message || 'Thanks—your message was sent.';
      contactForm.reset();
    } catch (error) {
      contactStatus.textContent = error.message || 'We could not send your message. Please try again or contact us via WhatsApp.';
    } finally {
      submitButton.disabled = false;
    }
  });
}
