export const METADATA_LABELS = {
  title: 'Başlık',
  tags: 'Etiketler',
  description: 'Açıklama'
};

export function isPendingReview(action) {
  return action?.type === 'LISTING_METADATA_UPDATE' &&
    action.status === 'VALIDATED' && action.qa?.passed === true &&
    action.etsy_modified === false && Boolean(action.id && action.listing_id) &&
    Array.isArray(action.changed_fields) && action.changed_fields.length > 0 &&
    action.changed_fields.every((field) => Object.hasOwn(METADATA_LABELS, field));
}

export function selectPendingReviews(actions = []) {
  // Only the latest proposal for a listing can represent its current review.
  const latest = new Map();
  for (const action of actions.filter((item) => item?.type === 'LISTING_METADATA_UPDATE').sort((a, b) =>
    (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0))) {
    if (!latest.has(String(action.listing_id))) latest.set(String(action.listing_id), action);
  }
  return [...latest.values()].filter(isPendingReview);
}

export function verifiedTaskReceipts(tasks = [], actions = []) {
  const byId = new Map(actions.map((action) => [action.id, action]));
  return tasks.filter((task) => task.status === 'COMPLETED' &&
    ['FULL_LISTING', 'SEO_CONTENT'].includes(task.task_scope) && task.etsy_modified === false)
    .sort((a, b) => (Date.parse(b.completed_at) || 0) - (Date.parse(a.completed_at) || 0))
    .flatMap((task) => {
      const action = byId.get(task.action_id);
      if (!isPendingReview(action) || String(action.listing_id) !== String(task.listing_id)) return [];
      return [{ task_id: task.id, listing_id: task.listing_id, generation_status: task.status,
        action_id: action.id, action_status: action.status, etsy_modified: false }];
    }).slice(0, 5);
}

export function revisionCommand(action, listingId, feedback) {
  if (!isPendingReview(action) || String(action.listing_id) !== String(listingId)) {
    throw Object.assign(new Error('Düzeltme istenecek taslak bulunamadı veya incelemeye açık değil.'), { code: 'REVISION_NOT_AVAILABLE' });
  }
  const note = String(feedback || '').trim();
  if (note.length < 8 || note.length > 800) {
    throw Object.assign(new Error('Düzeltme isteği 8–800 karakter olmalı.'), { code: 'REVISION_FEEDBACK_LENGTH' });
  }
  return `İncelenen taslak: ${action.id}. Başlık: ${String(action.proposed?.title || '').slice(0, 140)}. Sahibin düzeltme isteği: ${note}`;
}

export function reviewStatusLabel(status) {
  return {
    VALIDATED: 'İncelemeye hazır',
    BLOCKED: 'Düzeltme gerekli',
    EXECUTING: 'Yayınlanıyor',
    VERIFIED: 'Yayın doğrulandı',
    COMPLETED: 'Yayın doğrulandı',
    FAILED: 'İşlem tamamlanamadı',
    ROLLED_BACK: 'Geri alındı'
  }[status] || 'İşlem kaydı';
}
