const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Math.round(value)));

function has(text, terms) {
  const source = String(text || '').toLowerCase();
  return terms.some((term) => source.includes(term));
}

function titleScore(title) {
  const text = String(title || '').trim();
  let score = 45;
  if (text.length >= 45 && text.length <= 110) score += 25;
  else if (text.length >= 30 && text.length <= 130) score += 15;
  if ((text.match(/\|/g) || []).length <= 1) score += 10;
  if ((text.match(/,/g) || []).length <= 5) score += 10;
  if (!/\b(canvas|wall art|print)\b.*\b(canvas|wall art|print)\b.*\b(canvas|wall art|print)\b/i.test(text)) score += 10;
  return clamp(score);
}

function seoScore(listing) {
  const tags = Array.isArray(listing.tags) ? listing.tags : [];
  let score = 35;
  score += Math.min(30, tags.length * 2.3);
  if (String(listing.title || '').length >= 35) score += 15;
  if (String(listing.description || '').length >= 450) score += 15;
  if (listing.taxonomy_id) score += 5;
  return clamp(score);
}

function trustScore(description) {
  const d = String(description || '');
  const checks = [
    has(d, ['ready to hang', 'ready-to-hang']),
    has(d, ['tracking', 'tracked shipping', 'tracking number']),
    has(d, ['3 to 5 business days', '3–5 business days', '3-5 business days', 'processing time']),
    has(d, ['safe arrival', 'replace', 'replacement', 'damaged']),
    has(d, ['canvas', 'cotton', 'wood', 'frame', 'ink']),
    has(d, ['size', 'sizes', 'dimensions'])
  ];
  return clamp(22 + checks.filter(Boolean).length * 13);
}

function imageScore(imageCount, heroUrl) {
  let score = imageCount >= 9 ? 92 : imageCount >= 7 ? 84 : imageCount >= 5 ? 72 : imageCount >= 3 ? 58 : 40;
  if (heroUrl) score += 5;
  return clamp(score);
}

export function auditListing(listing) {
  const title = titleScore(listing.title);
  const seo = seoScore(listing);
  const trust = trustScore(listing.description);
  const images = imageScore(listing.image_count || 0, listing.hero_url);
  const conversion = clamp(title * 0.2 + seo * 0.25 + trust * 0.3 + images * 0.25);
  let decision = 'BLOCKED';
  if (conversion >= 88) decision = 'HERO_CANDIDATE';
  else if (conversion >= 75) decision = 'TEST_CANDIDATE';
  else if (conversion >= 60) decision = 'REPAIR';

  const findings = [];
  if (title < 75) findings.push('Title needs buyer-readable cleanup');
  if (seo < 75) findings.push('Search coverage needs review');
  if (trust < 75) findings.push('Trust/technical product information is incomplete');
  if (images < 75) findings.push('Image set or hero presentation is too weak');

  return {
    title_score: title,
    seo_score: seo,
    trust_score: trust,
    image_score: images,
    conversion_readiness: conversion,
    ad_readiness: conversion,
    decision,
    confidence: 'baseline',
    findings
  };
}
