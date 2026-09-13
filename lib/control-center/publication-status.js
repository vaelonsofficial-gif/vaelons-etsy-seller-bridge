const BLOCKER_LABELS = {
  write_mode_read_only: 'Panel şu anda yalnızca hazırlama ve inceleme modunda.',
  global_kill_switch_active: 'Etsy yayın güvenlik kilidi etkin.',
  control_center_auth_not_ready: 'Sahibin yayın erişimi henüz doğrulanmamış.',
  safe_listing_not_selected: 'İlk kontrollü yayın için ürün seçilmemiş.',
  autopilot_not_promoted: 'Otomatik yayın bu panelde kullanıma açık değil.'
};

// Display the server policy without granting or changing any write permission.
export function publicationStatus(policy, listingId = null) {
  if (!policy) return {
    canPublish: false,
    summary: 'Yayın erişimi şu anda doğrulanamıyor.',
    reasons: ['Erişim durumu okunamadı. Sayfayı yenileyerek tekrar kontrol edebilirsin.']
  };

  const reasons = [...new Set((policy.blockers || []).map((code) =>
    BLOCKER_LABELS[code] || 'Bir yayın güvenlik kontrolü henüz tamamlanmamış.'))];
  const allowedId = String(policy.allowed_listing_id || '');
  const globallyAllowed = policy.can_execute === true && policy.write_locked === false &&
    policy.mode === 'SAFE_WRITE' && /^\d+$/.test(allowedId) && reasons.length === 0;
  const matchesListing = listingId == null || allowedId === String(listingId);

  if (globallyAllowed && !matchesListing) {
    reasons.push(`Kontrollü yayın yalnızca #${allowedId} için açık; bu ürün henüz yetkilendirilmemiş.`);
  } else if (!globallyAllowed && reasons.length === 0) {
    reasons.push('Yayın erişimi henüz hazır değil.');
  }

  return {
    canPublish: globallyAllowed && matchesListing,
    summary: reasons.length ? reasons[0] : 'Yayın erişimi açık. Etsy’ye uygulamak için ayrıca onay vermen gerekir.',
    reasons
  };
}
