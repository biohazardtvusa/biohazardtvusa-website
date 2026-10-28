(() => {
  const pricing = document.getElementById('gold');
  if (!pricing) return;

  const businessPhoneE164 = '17262156959';
  const deviceCheck = document.createElement('section');
  deviceCheck.className = 'band';
  deviceCheck.id = 'device-check';
  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  const eyebrow = document.createElement('div');
  eyebrow.className = 'eyebrow';
  eyebrow.textContent = 'Not sure about your device?';
  const heading = document.createElement('h2');
  heading.textContent = 'Check compatibility before you order.';
  const description = document.createElement('p');
  description.className = 'intro';
  description.textContent = 'Message us with your device model, how many screens you want to watch at once, and whether you need setup help. We’ll help check compatibility and explain the next step.';
  const action = document.createElement('div');
  action.className = 'actions';
  const link = document.createElement('a');
  link.className = 'btn';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Check my device on WhatsApp ↗';
  const attribution = window.biohazardAttribution || {};
  const message = [
    'Hi, I would like to check device compatibility and get a quote.',
    'Device model:',
    'Number of screens to watch at once:',
    'Do I need setup help? (Yes/No):'
  ];
  if (attribution.source && !['direct', 'unknown'].includes(attribution.source)) {
    message.push('How I found BIOHAZARDTVUSA: ' + attribution.source);
  }
  if (attribution.campaign) message.push('Campaign: ' + attribution.campaign);
  link.href = 'https://wa.me/' + businessPhoneE164 + '?text=' + encodeURIComponent(message.join('\n'));
  action.append(link);
  wrap.append(eyebrow, heading, description, action);
  deviceCheck.append(wrap);
  pricing.after(deviceCheck);

  const reviews = document.getElementById('reviews');
  if (reviews) {
    const reviewEyebrow = reviews.querySelector('.eyebrow');
    const reviewHeading = reviews.querySelector('h2');
    const reviewIntro = reviews.querySelector('.intro');
    if (reviewEyebrow) reviewEyebrow.textContent = 'Customer voices';
    if (reviewHeading) reviewHeading.textContent = 'Hear from our clients.';
    if (reviewIntro) reviewIntro.textContent = 'Reviews are shown only after approval. Browse customer experiences or submit your own for review.';
    deviceCheck.after(reviews);
  }
})();
