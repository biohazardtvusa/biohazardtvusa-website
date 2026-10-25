(() => {
  const form = document.getElementById('email-signup-form');
  if (!form) return;
  const status = document.getElementById('email-signup-status');
  const button = form.querySelector('button[type="submit"]');
  // Re-align direct signup links after the existing large page images finish loading.
  window.addEventListener('load', () => {
    if (location.hash === '#email-updates' || location.hash === '#email-signup-form') {
      requestAnimationFrame(() => document.getElementById('email-updates').scrollIntoView({ block: 'start' }));
    }
  }, { once: true });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (button.disabled || !form.reportValidity()) return;
    button.disabled = true;
    button.textContent = 'Saving your signup…';
    status.textContent = 'Saving your signup…';
    const fields = new FormData(form);
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          email: fields.get('email'), firstName: fields.get('firstName'),
          state: fields.get('state'), consent: fields.get('consent') === 'yes',
          website: fields.get('website')
        })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'We could not save your signup. Please try again.');
      status.textContent = body.message;
      status.dataset.state = 'success';
      form.reset();
    } catch (error) {
      status.textContent = error.message || 'We could not save your signup. Please try again.';
      status.dataset.state = 'error';
    } finally {
      button.disabled = false;
      button.textContent = 'Join the email list';
    }
  });
})();
