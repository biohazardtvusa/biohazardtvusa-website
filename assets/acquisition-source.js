(() => {
  const storageKey = 'bhtv-acquisition-source-v1';
  const sourceAliases = {
    google: 'google',
    bing: 'bing',
    facebook: 'facebook',
    instagram: 'instagram',
    tiktok: 'tiktok',
    youtube: 'youtube',
    whatsapp: 'whatsapp',
    email: 'email',
    newsletter: 'email',
    referral: 'client_referral',
    friend: 'client_referral',
    client_referral: 'client_referral',
    other_website: 'other_website',
    other: 'other',
    direct: 'direct'
  };
  const validSources = new Set([
    'google', 'bing', 'facebook', 'instagram', 'tiktok', 'youtube', 'whatsapp',
    'email', 'client_referral', 'direct', 'other_website', 'other', 'unknown'
  ]);

  function sourceFromUrl() {
    const params = new URLSearchParams(location.search);
    const taggedSource = (params.get('utm_source') || '').trim().toLowerCase();
    if (taggedSource) return sourceAliases[taggedSource] || 'other';

    if (!document.referrer) return 'direct';
    try {
      const host = new URL(document.referrer).hostname.toLowerCase().replace(/^www\./, '');
      if (host === location.hostname.toLowerCase()) return '';
      if (host === 'google.com' || host.endsWith('.google.com')) return 'google';
      if (host === 'bing.com' || host.endsWith('.bing.com')) return 'bing';
      if (host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.com') return 'facebook';
      if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'instagram';
      if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) return 'tiktok';
      if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') return 'youtube';
      if (host === 'whatsapp.com' || host.endsWith('.whatsapp.com') || host === 'wa.me') return 'whatsapp';
      return 'other_website';
    } catch {
      return 'other_website';
    }
  }

  function campaignFromUrl() {
    const value = new URLSearchParams(location.search).get('utm_campaign') || '';
    return value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48);
  }

  function readSaved() {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (
        value &&
        typeof value.source === 'string' &&
        Number.isFinite(value.savedAt) &&
        Date.now() - value.savedAt < 90 * 24 * 60 * 60 * 1000
      ) return value;
    } catch {}
    return null;
  }

  let saved = readSaved();
  const currentSource = sourceFromUrl();
  const currentCampaign = campaignFromUrl();

  if (!saved || (saved.source === 'direct' && currentSource && currentSource !== 'direct')) {
    saved = {
      source: currentSource || 'direct',
      campaign: currentCampaign,
      savedAt: Date.now()
    };
    try { localStorage.setItem(storageKey, JSON.stringify(saved)); } catch {}
  }

  window.biohazardAttribution = {
    source: validSources.has(saved.source) ? saved.source : 'unknown',
    campaign: typeof saved.campaign === 'string'
      ? saved.campaign.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48)
      : ''
  };
})();
