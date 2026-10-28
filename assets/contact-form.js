const contactForm = document.getElementById('contact-form-submit');
const contactStatus = document.getElementById('contact-status');

if (contactForm && contactStatus) {
  contactForm.addEventListener('submit', async event => {
    event.preventDefault();
    const submitButton = contactForm.querySelector('button[type="submit"]');
    const values = Object.fromEntries(new FormData(contactForm).entries());

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
