const clamp = (value, min = 0, max = 100) => Math.max(min, Math.min(max, Math.round(value)));

function normalized(text) {
  return String(text || '').trim().toLowerCase();
}

function includesAny(text, terms) {
  const source = normalized(text);
  return terms.some((term) => source.includes(term));
}

function titleScore(title) {
  const text = String(title || '').trim();
  let score = 20;

  if (text.length >= 45 && text.length <= 110) score += 30;
  else if (text.length >= 30 && text.length <= 130) score += 18;

  const separators = (text.match(/[|]/g) || []).length;
  const commas = (text.match(/,/g) || []).length;
  if (separators <= 1) score += 10;
  if (commas <= 5) score += 10;
  if (/\b(canvas|wall art|art print)\b/i.test(text)) score += 15;
  if (!/[A-Z]{6,}/.test(text)) score += 10;

  const buyerTerms = text.match(/\b(canvas|wall art|print|decor)\b/gi) || [];
  if (buyerTerms.length <= 5) score += 5;
  else score -= 10;

  return clamp(score);
}

function seoScore(listing) {
  const tags = Array.isArray(listing.tags) ? listing.tags.map(normalized).filter(Boolean) : [];
  const uniqueTags = new Set(tags);
  const titleTokens = new Set(normalized(listing.title).match(/[a-z]{4,}/g) || []);
  const tagTokens = new Set(tags.flatMap((tag) => tag.match(/[a-z]{4,}/g) || []));
  const overlap = [...titleTokens].filter((token) => tagTokens.has(token)).length;
  let score = 10;

  if (tags.length === 13) score += 25;
  else score += Math.min(20, tags.length * 1.5);
  if (uniqueTags.size === tags.length) score += 15;
  if (tags.length > 0 && tags.every((tag) => tag.length <= 20)) score += 10;
  if (String(listing.title || '').trim().length >= 35) score += 10;
  if (String(listing.description || '').trim().length >= 600) score += 10;
  if (listing.taxonomy_id) score += 10;
  if (overlap >= 3) score += 10;

  return clamp(score);
}

function trustScore(description) {
  const d = String(description || '');
  const checks = [
    includesAny(d, ['ready to hang', 'ready-to-hang']),
    includesAny(d, ['tracking number', 'tracked shipping', 'free worldwide shipping with tracking']),
    includesAny(d, ['3 to 5 business days', '3–5 business days', '3-5 business days']),
    includesAny(d, ['safe arrival guarantee', 'arrives damaged', 'replacement at no cost']),
    includesAny(d, ['canvas']) && includesAny(d, ['cotton', 'wood', 'frame', 'archival ink']),
    includesAny(d, ['size', 'sizes', 'dimensions']),
    includesAny(d, ['frame color', 'frame colour', 'black frame', 'gold frame', 'natural frame', 'floating frame']),
    includesAny(d, ['protective corner', 'sturdy box', 'secure packaging']),
    includesAny(d, ['color may vary', 'colour may vary', 'monitor settings', 'wipe clean', 'care instructions'])
  ];

  return clamp((checks.filter(Boolean).length / checks.length) * 100);
}

function imageCoverageScore(imageCount, heroUrl) {
  let score = heroUrl ? 25 : 0;
  if (imageCount >= 10) score += 50;
  else if (imageCount >= 8) score += 44;
  else if (imageCount >= 6) score += 34;
  else if (imageCount >= 4) score += 24;
  else if (imageCount >= 1) score += 10;

  // A photo count cannot prove thumbnail quality. Vision review unlocks the final 25 points later.
  return clamp(score, 0, 75);
}

export function auditListing(listing) {
  const title = titleScore(listing.title);
  const seo = seoScore(listing);
  const trust = trustScore(listing.description);
  const images = imageCoverageScore(listing.image_count || 0, listing.hero_url);
  const metadataReadiness = clamp(title * 0.25 + seo * 0.25 + trust * 0.35 + images * 0.15);

  const criticalBlockers = [];
  if (!Number.isFinite(Number(listing.listing_id))) criticalBlockers.push('Listing ID okunamadı');
  if (!String(listing.title || '').trim()) criticalBlockers.push('Başlık eksik');
  if (!listing.hero_url) criticalBlockers.push('Ana görsel eksik');
  if (!listing.price || !Number.isFinite(Number(listing.price.amount))) criticalBlockers.push('Fiyat okunamadı');
  if ((listing.tags || []).length < 5) criticalBlockers.push('Arama etiketi sayısı kritik seviyede');

  let decision = 'REVIEW_REQUIRED';
  if (criticalBlockers.length > 0) decision = 'BLOCKED';
  else if (metadataReadiness < 82 || title < 75 || seo < 80 || trust < 78 || images < 65) decision = 'REPAIR';

  const findings = [...criticalBlockers];
  if (title < 75) findings.push('Başlık buyer-friendly yapı için gözden geçirilmeli');
  if (seo < 80) findings.push('SEO kapsaması veya etiket kalitesi yetersiz');
  if (trust < 78) findings.push('Teknik ürün ve güven bilgileri eksik');
  if (images < 65) findings.push('Görsel seti sayısal olarak yetersiz');
  findings.push('Hero kalitesi görsel denetim bekliyor');

  return {
    title_score: title,
    seo_score: seo,
    trust_score: trust,
    image_score: images,
    metadata_readiness: metadataReadiness,
    conversion_readiness: null,
    ad_readiness: null,
    ads_eligible: false,
    requires_visual_review: true,
    decision,
    confidence: 'metadata_only',
    findings: [...new Set(findings)]
  };
}
