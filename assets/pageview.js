(() => {
  const attribution = window.biohazardAttribution || {};
  const referralCode = new URLSearchParams(location.search).get('ref') || '';
  const source = /^BHTV-[A-Fa-f0-9]{10}$/.test(referralCode)
    ? 'client_referral'
    : (attribution.source || 'unknown');

  fetch('/.netlify/functions/pageview', {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      page: '/',
      source,
      campaign: attribution.campaign || ''
    })
  }).catch(() => {
    // Analytics must never interfere with the website.
  });
})();
