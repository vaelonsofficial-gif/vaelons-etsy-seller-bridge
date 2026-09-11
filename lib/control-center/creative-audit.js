import { createHash } from 'node:crypto';

export const CREATIVE_IMAGE_ROLES = [
  { id: 'hero', label: 'Hero thumbnail', purpose: 'Search sayfasında artwork’ü büyük, net ve premium gösterir.' },
  { id: 'scale', label: 'Scale / room context', purpose: 'İnsan, koltuk veya yatak referansıyla ölçü algısı verir.' },
  { id: 'sizes', label: 'Size guide', purpose: 'Tüm ölçüleri tek bakışta açıklar.' },
  { id: 'frame_options', label: 'Frame options', purpose: 'Mevcut çerçeve renklerini doğru biçimde gösterir.' },
  { id: 'ready_to_hang', label: 'Ready to hang', purpose: 'Asma sistemini ve teslim biçimini kanıtlar.' },
  { id: 'materials', label: 'Materials', purpose: 'Doğrulanmış canvas, şase ve baskı bilgilerini gösterir.' },
  { id: 'quality_control', label: 'Quality control', purpose: 'Üretim ve kalite kontrol sürecini açıklar.' },
  { id: 'packaging', label: 'Protective packaging', purpose: 'Koruyucu ambalajı somut olarak gösterir.' },
  { id: 'shipping', label: 'Tracked shipping', purpose: 'Hazırlanma ve takipli gönderim bilgisini gösterir.' },
  { id: 'safe_arrival', label: 'Safe Arrival Guarantee', purpose: 'Hasarlı teslimat çözümünü açıklar.' }
];

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizedImage(image) {
  return {
    image_id: asNumber(image?.image_id ?? image?.listing_image_id),
    rank: asNumber(image?.rank),
    width: asNumber(image?.width ?? image?.full_width),
    height: asNumber(image?.height ?? image?.full_height),
    alt_text: String(image?.alt_text || '').trim(),
    url: String(image?.url_fullxfull || image?.url_570xN || '').trim()
  };
}

export function creativeImageManifest(images) {
  return (Array.isArray(images) ? images : [])
    .map(normalizedImage)
    .sort((left, right) => (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER));
}

export function creativeImageManifestHash(images) {
  return createHash('sha256')
    .update(JSON.stringify(creativeImageManifest(images)))
    .digest('hex');
}

function signal(id, label, status, weight, evidence) {
  return { id, label, status, weight, evidence };
}

function finding(code, severity, message, evidence, nextAction) {
  return {
    code,
    severity,
    message,
    evidence,
    next_action: nextAction
  };
}

export function auditCreativeListing(listing, images) {
  const manifest = creativeImageManifest(images);
  const imageIds = manifest.map((image) => image.image_id).filter(Boolean);
  const ranks = manifest.map((image) => image.rank).filter(Boolean);
  const rankOne = manifest.find((image) => image.rank === 1) || null;
  const hero = rankOne || manifest[0] || null;
  const uniqueIds = new Set(imageIds);
  const uniqueRanks = new Set(ranks);
  const expectedRanks = Array.from({ length: manifest.length }, (_, index) => index + 1);
  const ranksContinuous =
    ranks.length === manifest.length &&
    uniqueRanks.size === manifest.length &&
    expectedRanks.every((rank) => uniqueRanks.has(rank));
  const validUrlCount = manifest.filter((image) => image.url).length;
  const knownDimensionCount = manifest.filter((image) => image.width && image.height).length;
  const heroShortestEdge = hero?.width && hero?.height ? Math.min(hero.width, hero.height) : null;
  const heroAspectRatio = hero?.width && hero?.height
    ? Number((hero.width / hero.height).toFixed(3))
    : null;

  const signals = [
    signal('images_present', 'Görsel seti', manifest.length > 0 ? 'PASS' : 'FAIL', 20, `${manifest.length} image`),
    signal('rank_one_present', 'Hero rank', rankOne ? 'PASS' : 'FAIL', 15, rankOne ? `Image #${rankOne.image_id}` : 'Rank 1 bulunamadı'),
    signal(
      'unique_image_ids',
      'Image ID bütünlüğü',
      manifest.length > 0 && imageIds.length === manifest.length && uniqueIds.size === manifest.length ? 'PASS' : 'FAIL',
      15,
      `${uniqueIds.size}/${manifest.length} unique`
    ),
    signal('rank_continuity', 'Sıralama bütünlüğü', manifest.length > 0 && ranksContinuous ? 'PASS' : 'FAIL', 10, manifest.length > 0 && ranksContinuous ? '1’den kesintisiz' : 'Eksik veya tekrar eden rank'),
    signal('resolvable_urls', 'Görsel kaynakları', validUrlCount === manifest.length && manifest.length > 0 ? 'PASS' : 'FAIL', 15, `${validUrlCount}/${manifest.length} URL`),
    signal(
      'dimensions_known',
      'Boyut verisi',
      knownDimensionCount === manifest.length && manifest.length > 0 ? 'PASS' : knownDimensionCount > 0 ? 'PARTIAL' : 'UNKNOWN',
      10,
      `${knownDimensionCount}/${manifest.length} known`
    ),
    signal(
      'hero_resolution',
      'Hero çözünürlüğü',
      heroShortestEdge === null ? 'UNKNOWN' : heroShortestEdge >= 2000 ? 'PASS' : 'REVIEW',
      10,
      heroShortestEdge === null ? 'Boyut bilinmiyor' : `${hero.width}×${hero.height}px`
    ),
    signal(
      'role_capacity',
      '10 rol kapasitesi',
      manifest.length >= CREATIVE_IMAGE_ROLES.length ? 'PASS' : 'REVIEW',
      5,
      `${manifest.length}/${CREATIVE_IMAGE_ROLES.length} slot`
    )
  ];

  const scoreValue = signals.reduce((total, item) => {
    if (item.status === 'PASS') return total + item.weight;
    if (item.status === 'PARTIAL') return total + item.weight * 0.5;
    return total;
  }, 0);
  const technicalIntegrityScore = Math.round(scoreValue);
  const findings = [];

  if (manifest.length === 0) {
    findings.push(finding('image_set_empty', 'CRITICAL', 'Listing görsel seti boş.', '0 image', 'Etsy görsel kaynağını doğrula.'));
  }
  if (manifest.length > 0 && !rankOne) {
    findings.push(finding('hero_rank_missing', 'CRITICAL', 'Rank 1 hero görseli bulunamadı.', `Ranks: ${ranks.join(', ') || 'none'}`, 'Görsel sıralamasını onarım kuyruğuna al.'));
  }
  if (imageIds.length !== manifest.length || uniqueIds.size !== manifest.length) {
    findings.push(finding('image_identity_invalid', 'CRITICAL', 'Görsel kimliklerinde eksik veya tekrar var.', `${uniqueIds.size}/${manifest.length} unique`, 'Image ID setini Etsy’den yeniden senkronize et.'));
  }
  if (!ranksContinuous && manifest.length > 0) {
    findings.push(finding('image_rank_invalid', 'HIGH', 'Görsel sıralaması kesintisiz değil.', `Ranks: ${ranks.join(', ') || 'none'}`, 'Rank planını doğrula; körlemesine yeniden sıralama yapma.'));
  }
  if (validUrlCount !== manifest.length) {
    findings.push(finding('image_url_missing', 'CRITICAL', 'Bir veya daha fazla görsel kaynağı okunamıyor.', `${validUrlCount}/${manifest.length} URL`, 'Eksik görsel kayıtlarını yeniden çek.'));
  }
  if (heroShortestEdge !== null && heroShortestEdge < 2000) {
    findings.push(finding('hero_resolution_review', 'MEDIUM', 'Hero görselinin kısa kenarı 2000px altında.', `${hero.width}×${hero.height}px`, 'Kaynak dosya çözünürlüğünü kontrol et.'));
  }
  if (manifest.length < CREATIVE_IMAGE_ROLES.length) {
    findings.push(finding('role_capacity_short', 'MEDIUM', 'Önerilen 10 görsel rolü için yeterli slot yok.', `${manifest.length}/${CREATIVE_IMAGE_ROLES.length} slot`, 'Eksik rol görsellerini Creative Studio’da planla.'));
  }

  const hasCriticalFailure = findings.some((item) => item.severity === 'CRITICAL');

  return {
    version: 1,
    listing_id: Number(listing?.listing_id) || null,
    status: hasCriticalFailure ? 'BLOCKED' : 'VISION_REQUIRED',
    technical_integrity_score: technicalIntegrityScore,
    visual_quality_score: null,
    creative_readiness: null,
    ads_eligible: false,
    manifest_hash: creativeImageManifestHash(manifest),
    image_count: manifest.length,
    hero: hero ? {
      image_id: hero.image_id,
      rank: hero.rank,
      width: hero.width,
      height: hero.height,
      aspect_ratio: heroAspectRatio
    } : null,
    artwork_lock: {
      status: 'SOURCE_NOT_SELECTED',
      source_image_id: null,
      source_hash: null,
      requirement: 'Artwork kaynağı seçilip piksel referansı kaydedilmeden üretim veya upload yapılamaz.'
    },
    vision: {
      status: 'NOT_RUN',
      model: null,
      reviewed_at: null,
      checks: [
        'artwork_visibility',
        'thumbnail_stop_power',
        'crop_safety',
        'artwork_identity_preservation',
        'room_scale_credibility',
        'text_legibility',
        'image_role_coverage'
      ]
    },
    required_roles: CREATIVE_IMAGE_ROLES.map((role) => ({ ...role, status: 'UNKNOWN', evidence_image_ids: [] })),
    signals,
    findings,
    blockers: [
      'vision_not_run',
      'artwork_source_not_locked',
      ...(hasCriticalFailure ? ['technical_image_integrity_failed'] : [])
    ],
    generated_at: new Date().toISOString()
  };
}

export function summarizeCreativeAudit(audit) {
  return {
    status: audit.status,
    technical_integrity_score: audit.technical_integrity_score,
    visual_quality_score: audit.visual_quality_score,
    creative_readiness: audit.creative_readiness,
    manifest_hash: audit.manifest_hash,
    artwork_lock_status: audit.artwork_lock.status,
    vision_status: audit.vision.status,
    image_count: audit.image_count,
    finding_count: audit.findings.length,
    primary_finding: audit.findings[0]?.message || 'Teknik görsel bütünlüğü hazır; vision incelemesi bekleniyor.'
  };
}
