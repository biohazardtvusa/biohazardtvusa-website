(() => {
  const endpoint = '/.netlify/functions/customer-portal';
  const status = document.getElementById('home-auth-status');
  if (!status) return;

  const navLinks = document.querySelector('.nav .links');
  if (navLinks) {
    navLinks.querySelector('a[href="#live"]')?.remove();
    navLinks.querySelector('a[href="#ondemand"]')?.remove();
    const plansLink = navLinks.querySelector('a[href="#gold"]');
    if (plansLink) plansLink.textContent = 'Live TV Plans';
    const devicesLink = navLinks.querySelector('a[href="#devices"]');
    if (devicesLink) devicesLink.textContent = 'Devices & Setup';
    if (!navLinks.querySelector('a[href="#faq"]')) {
      const faqLink = document.createElement('a');
      faqLink.href = '#faq';
      faqLink.textContent = 'FAQ';
      const reviewsLink = navLinks.querySelector('a[href="#reviews"]');
      navLinks.insertBefore(faqLink, reviewsLink || null);
    }
  }
  if (navLinks && !navLinks.querySelector('a[data-referral-link]')) {
    const referralLink = document.createElement('a');
    referralLink.href = '#client-portal';
    referralLink.textContent = 'Refer a Friend';
    referralLink.dataset.referralLink = 'true';
    const contactLink = navLinks.querySelector('a[href="#contact"]');
    if (contactLink) contactLink.after(referralLink);
    else navLinks.append(referralLink);
  }

  const setStatus = (message, state = '') => {
    status.textContent = message;
    status.dataset.state = state;
  };
  const api = async (action, data) => {
    const response = await fetch(endpoint + '?action=' + encodeURIComponent(action), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(data)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'We could not complete this request. Please try again.');
    return body;
  };
  const bind = (id, handler) => {
    const form = document.getElementById(id);
    if (form) form.addEventListener('submit', event => {
      event.preventDefault();
      handler(event, form);
    });
  };
  const run = async (form, pendingMessage, action, data, success) => {
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    setStatus(pendingMessage);
    try {
      const result = await api(action, data);
      if (success) await success(result);
      else setStatus(result.message, 'success');
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  };

  bind('home-login-form', async (_event, form) => {
    const email = document.getElementById('home-login-email').value;
    const password = document.getElementById('home-login-password').value;
    await run(form, 'Signing you in…', 'password-login', { email, password }, () => {
      document.getElementById('home-login-password').value = '';
      location.assign('/customer-portal.html');
    });
  });

  bind('home-request-form', async (_event, form) => {
    const password = document.getElementById('home-request-password').value;
    const passwordConfirm = document.getElementById('home-request-password-confirm').value;
    if (password !== passwordConfirm) {
      setStatus('The passwords do not match.', 'error');
      return;
    }
    await run(form, 'Creating your request…', 'request-account', {
      name: document.getElementById('home-request-name').value,
      email: document.getElementById('home-request-email').value,
      password,
      passwordConfirm,
      referralCode: document.getElementById('home-request-referral').value
    }, result => {
      document.getElementById('home-request-password').value = '';
      document.getElementById('home-request-password-confirm').value = '';
      setStatus(result.message, 'success');
    });
  });

  bind('home-password-help-form', async (_event, form) => {
    await run(form, 'Requesting a secure password link…', 'password-reset-request', {
      email: document.getElementById('home-password-help-email').value
    });
  });

  bind('home-password-reset-form', async (_event, form) => {
    const password = document.getElementById('home-password-reset-password').value;
    const passwordConfirm = document.getElementById('home-password-reset-confirm').value;
    if (password !== passwordConfirm) {
      setStatus('The passwords do not match.', 'error');
      return;
    }
    await run(form, 'Saving your password…', 'password-reset', {
      token: document.getElementById('home-password-reset-token').value,
      password,
      passwordConfirm
    }, () => {
      document.getElementById('home-password-reset-password').value = '';
      document.getElementById('home-password-reset-confirm').value = '';
      setStatus('Password saved. Opening your referral dashboard…', 'success');
      location.assign('/customer-portal.html');
    });
  });

  const params = new URLSearchParams(location.search);
  const referral = params.get('ref') || '';
  if (/^BHTV-[A-Fa-f0-9]{10}$/.test(referral)) {
    document.getElementById('home-request-referral').value = referral.toUpperCase();
  }

  const hashParams = new URLSearchParams(location.hash.slice(1));
  const confirmationToken = hashParams.get('confirm') || '';
  const resetToken = hashParams.get('password-reset') || '';
  history.replaceState(null, '', location.pathname + location.search);
  if (resetToken) {
    document.getElementById('home-password-reset-token').value = resetToken;
    document.getElementById('home-password-reset-form').hidden = false;
    setStatus('Choose a new password for your client account.');
    document.getElementById('client-portal').scrollIntoView({ block: 'start' });
    document.getElementById('home-password-reset-password').focus({ preventScroll: true });
  } else if (confirmationToken) {
    setStatus('Verifying your email…');
    api('verify-account', { token: confirmationToken })
      .then(result => setStatus(result.message, 'success'))
      .catch(error => setStatus(error.message, 'error'));
    document.getElementById('client-portal').scrollIntoView({ block: 'start' });
  }
})();
