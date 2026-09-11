import { createHash, randomUUID } from 'node:crypto';

import { etsyRequest, getVerifiedShopIdentity } from '../../src/etsy.js';
import {
  asListingId,
  patchFromAction,
  snapshotFromListing,
  snapshotHash,
  validateMetadataProposal,
  verifyMetadata
} from './metadata.js';
import { assertWriteAllowed, getWritePolicy } from './write-policy.js';
import {
  acquireListingLock,
  appendActionEvent,
  createAction,
  getAction,
  releaseListingLock,
  updateAction
} from './store.js';

function proposalHash(listingId, beforeHash, proposed) {
  return createHash('sha256')
    .update(JSON.stringify({ listingId, beforeHash, proposed }))
    .digest('hex');
}

function publicAction(action) {
  if (!action) return null;
  return {
    id: action.id,
    listing_id: action.listing_id,
    type: action.type,
    status: action.status,
    changed_fields: action.changed_fields,
    before: action.before,
    proposed: action.proposed,
    qa: action.qa,
    validation_errors: action.validation_errors || [],
    validation_warnings: action.validation_warnings || [],
    reason: action.reason,
    created_at: action.created_at,
    updated_at: action.updated_at,
    etsy_modified: action.etsy_modified === true
  };
}

export async function prepareMetadataAction({
  listingId,
  title,
  tags,
  description,
  reason = 'control_center_manual_proposal'
}) {
  const id = asListingId(listingId);
  const identity = await getVerifiedShopIdentity();
  const listing = await etsyRequest(`/listings/${id}`);

  if (String(listing?.shop_id || '') !== String(identity.shop_id)) {
    const error = new Error('Listing doğrulanan VAELONS mağazasına ait değil');
    error.status = 409;
    error.code = 'LISTING_SHOP_MISMATCH';
    throw error;
  }

  const before = snapshotFromListing(listing);
  const validation = validateMetadataProposal(before, { title, tags, description });

  if (validation.changed_fields.length === 0) {
    return {
      created: false,
      no_changes: true,
      action: null,
      validation,
      etsy_modified: false
    };
  }

  const beforeHash = snapshotHash(before);
  const now = new Date().toISOString();
  const action = {
    schema_version: 1,
    id: randomUUID(),
    idempotency_key: proposalHash(id, beforeHash, validation.proposed),
    listing_id: Number(id),
    shop_id: Number(identity.shop_id),
    type: 'LISTING_METADATA_UPDATE',
    status: validation.valid ? 'VALIDATED' : 'BLOCKED',
    reason: String(reason || 'control_center_manual_proposal').slice(0, 500),
    before,
    before_hash: beforeHash,
    proposed: validation.proposed,
    changed_fields: validation.changed_fields,
    qa: validation.qa,
    validation_errors: validation.errors,
    validation_warnings: validation.warnings,
    etsy_modified: false,
    created_at: now,
    updated_at: now
  };

  const result = await createAction(action);
  return {
    created: result.created,
    no_changes: false,
    action: publicAction(result.action),
    validation,
    etsy_modified: false
  };
}

export async function executeMetadataAction({ actionId, approval }) {
  const action = await getAction(String(actionId || ''));
  if (!action) {
    const error = new Error('İşlem kaydı bulunamadı veya süresi doldu');
    error.status = 404;
    throw error;
  }

  const policy = getWritePolicy();
  assertWriteAllowed(policy, action.listing_id);

  if (String(approval || '').trim() !== `YAYINLA ${action.listing_id}`) {
    const error = new Error(`Onay metni tam olarak YAYINLA ${action.listing_id} olmalı`);
    error.status = 400;
    error.code = 'APPROVAL_MISMATCH';
    throw error;
  }

  if (!['VALIDATED', 'READY'].includes(action.status) || action?.qa?.passed !== true) {
    const error = new Error('Bu işlem doğrulanmış yayınlama durumunda değil');
    error.status = 409;
    error.code = 'ACTION_NOT_READY';
    throw error;
  }

  const lockOwner = `${action.id}:${randomUUID()}`;
  let etsyModified = false;
  await acquireListingLock(action.listing_id, lockOwner);

  try {
    const identity = await getVerifiedShopIdentity();
    if (String(identity.shop_id) !== String(action.shop_id)) {
      const error = new Error('Mağaza kimliği işlem kaydıyla eşleşmiyor');
      error.status = 409;
      throw error;
    }

    const currentListing = await etsyRequest(`/listings/${action.listing_id}`);
    const current = snapshotFromListing(currentListing);

    if (snapshotHash(current) !== action.before_hash) {
      await updateAction(action.id, { status: 'BLOCKED', block_reason: 'listing_changed_after_preview' });
      await appendActionEvent(action.id, {
        type: 'EXECUTION_BLOCKED',
        status: 'BLOCKED',
        reason: 'listing_changed_after_preview',
        etsy_modified: false
      });
      const error = new Error('Listing taslak oluşturulduktan sonra değişmiş; yeni taslak gerekli');
      error.status = 409;
      throw error;
    }

    await updateAction(action.id, { status: 'EXECUTING' });
    await appendActionEvent(action.id, { type: 'EXECUTION_STARTED', status: 'EXECUTING', etsy_modified: false });

    const patch = patchFromAction(action, 'proposed');
    await etsyRequest(`/shops/${identity.shop_id}/listings/${action.listing_id}`, {
      method: 'PATCH',
      body: patch
    });
    etsyModified = true;

    const verifiedListing = await etsyRequest(`/listings/${action.listing_id}`);
    const verified = snapshotFromListing(verifiedListing);
    const verifiedOk = verifyMetadata(action.proposed, verified, action.changed_fields);
    const status = verifiedOk ? 'COMPLETED' : 'FAILED';

    const updated = await updateAction(action.id, {
      status,
      after_verified: verified,
      after_hash: snapshotHash(verified),
      verification_passed: verifiedOk,
      etsy_modified: true,
      completed_at: verifiedOk ? new Date().toISOString() : null
    });

    await appendActionEvent(action.id, {
      type: verifiedOk ? 'EXECUTION_VERIFIED' : 'EXECUTION_VERIFICATION_FAILED',
      status,
      etsy_modified: true
    });

    if (!verifiedOk) {
      const error = new Error('Etsy değişikliği gönderildi ancak sonuç doğrulanamadı');
      error.status = 409;
      error.etsyModified = true;
      throw error;
    }

    return { action: publicAction(updated), verified: true, etsy_modified: true };
  } catch (error) {
    if (etsyModified) error.etsyModified = true;
    throw error;
  } finally {
    try {
      await releaseListingLock(action.listing_id, lockOwner);
    } catch {
      // The lock expires automatically. Never hide the original Etsy result.
    }
  }
}

export async function rollbackMetadataAction({ actionId, approval }) {
  const action = await getAction(String(actionId || ''));
  if (!action) {
    const error = new Error('Geri alınacak işlem bulunamadı');
    error.status = 404;
    throw error;
  }

  const policy = getWritePolicy();
  assertWriteAllowed(policy, action.listing_id);

  if (String(approval || '').trim() !== `GERI AL ${action.listing_id}`) {
    const error = new Error(`Onay metni tam olarak GERI AL ${action.listing_id} olmalı`);
    error.status = 400;
    throw error;
  }

  if (action.status !== 'COMPLETED' || !action.after_hash) {
    const error = new Error('Yalnızca doğrulanmış tamamlanmış işlem geri alınabilir');
    error.status = 409;
    throw error;
  }

  const lockOwner = `${action.id}:rollback:${randomUUID()}`;
  let etsyModified = false;
  await acquireListingLock(action.listing_id, lockOwner);

  try {
    const identity = await getVerifiedShopIdentity();
    if (String(identity.shop_id) !== String(action.shop_id)) {
      const error = new Error('Mağaza kimliği işlem kaydıyla eşleşmiyor');
      error.status = 409;
      throw error;
    }

    const currentListing = await etsyRequest(`/listings/${action.listing_id}`);
    const current = snapshotFromListing(currentListing);

    if (snapshotHash(current) !== action.after_hash) {
      const error = new Error('Listing yayınlamadan sonra değişmiş; otomatik geri alma engellendi');
      error.status = 409;
      throw error;
    }

    await updateAction(action.id, { status: 'ROLLING_BACK' });
    await appendActionEvent(action.id, { type: 'ROLLBACK_STARTED', status: 'ROLLING_BACK', etsy_modified: false });

    await etsyRequest(`/shops/${identity.shop_id}/listings/${action.listing_id}`, {
      method: 'PATCH',
      body: patchFromAction({ ...action, proposed: action.before }, 'proposed')
    });
    etsyModified = true;

    const verifiedListing = await etsyRequest(`/listings/${action.listing_id}`);
    const verified = snapshotFromListing(verifiedListing);
    const rollbackOk = verifyMetadata(action.before, verified, action.changed_fields);
    const status = rollbackOk ? 'ROLLED_BACK' : 'FAILED';
    const updated = await updateAction(action.id, {
      status,
      rollback_verified: rollbackOk,
      rollback_after: verified,
      rolled_back_at: rollbackOk ? new Date().toISOString() : null,
      etsy_modified: true
    });

    await appendActionEvent(action.id, {
      type: rollbackOk ? 'ROLLBACK_VERIFIED' : 'ROLLBACK_VERIFICATION_FAILED',
      status,
      etsy_modified: true
    });

    if (!rollbackOk) {
      const error = new Error('Geri alma gönderildi ancak sonuç doğrulanamadı');
      error.status = 409;
      error.etsyModified = true;
      throw error;
    }

    return { action: publicAction(updated), verified: true, etsy_modified: true };
  } catch (error) {
    if (etsyModified) error.etsyModified = true;
    throw error;
  } finally {
    try {
      await releaseListingLock(action.listing_id, lockOwner);
    } catch {
      // The lock expires automatically. Never hide the original rollback result.
    }
  }
}
