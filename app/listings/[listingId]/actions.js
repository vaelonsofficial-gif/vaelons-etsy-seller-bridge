'use server';

import { revalidatePath } from 'next/cache';

import {
  executeMetadataAction,
  prepareMetadataAction,
  rollbackMetadataAction
} from '../../../lib/control-center/actions.js';
import { generateListingContent } from '../../../lib/control-center/content-generator.js';

function failure(error) {
  return {
    ok: false,
    message: error?.message || 'İşlem tamamlanamadı',
    code: error?.code || 'ACTION_FAILED',
    etsy_modified: error?.etsyModified === true
  };
}

export async function prepareListingChange(_previousState, formData) {
  try {
    const listingId = String(formData.get('listing_id') || '');
    const result = await prepareMetadataAction({
      listingId,
      title: String(formData.get('title') || ''),
      tags: String(formData.get('tags') || '').split(/\r?\n/),
      description: String(formData.get('description') || ''),
      reason: String(formData.get('reason') || 'control_center_editor'),
      strictClaims: true,
      source: 'OWNER_EDIT'
    });

    revalidatePath('/actions');

    if (result.no_changes) {
      return {
        ok: true,
        message: 'Herhangi bir değişiklik bulunmadı.',
        action: null,
        validation: result.validation,
        etsy_modified: false
      };
    }

    return {
      ok: result.validation.valid,
      message: result.validation.valid
        ? 'Değişiklik taslağı doğrulandı ve işlem kuyruğuna kaydedildi.'
        : 'Taslak güvenlik doğrulamasından geçemedi.',
      action: result.action,
      validation: result.validation,
      etsy_modified: false
    };
  } catch (error) {
    return failure(error);
  }
}

export async function generateListingDraft(_previousState, formData) {
  try {
    const result = await generateListingContent({
      listingId: String(formData.get('listing_id') || ''),
      command: String(formData.get('command') || '')
    });

    revalidatePath('/actions');
    revalidatePath(`/generations/${result.id}`);

    const valid = result.status === 'COMPLETED' && result.validation?.valid === true;
    return {
      ok: valid,
      message: valid
        ? result.cached
          ? 'Aynı listing sürümü için doğrulanmış içerik yeniden kullanıldı.'
          : 'İçerik hazırlandı, güvenlik kontrollerinden geçti ve onayınıza sunuldu.'
        : 'Üretilen içerik güvenlik doğrulamasından geçemedi; Etsy’ye gönderilemez.',
      generation: result,
      action: result.action,
      validation: result.validation,
      etsy_modified: false
    };
  } catch (error) {
    return failure(error);
  }
}

export async function executeListingChange(_previousState, formData) {
  try {
    const result = await executeMetadataAction({
      actionId: String(formData.get('action_id') || ''),
      approval: String(formData.get('approval') || '')
    });
    revalidatePath('/');
    revalidatePath('/actions');
    revalidatePath(`/listings/${result.action.listing_id}`);
    return {
      ok: true,
      message: 'Etsy değişikliği uygulandı ve sonuç doğrulandı.',
      ...result
    };
  } catch (error) {
    return failure(error);
  }
}

export async function rollbackListingChange(_previousState, formData) {
  try {
    const result = await rollbackMetadataAction({
      actionId: String(formData.get('action_id') || ''),
      approval: String(formData.get('approval') || '')
    });
    revalidatePath('/');
    revalidatePath('/actions');
    revalidatePath(`/listings/${result.action.listing_id}`);
    return {
      ok: true,
      message: 'Değişiklik geri alındı ve Etsy sonucu doğrulandı.',
      ...result
    };
  } catch (error) {
    return failure(error);
  }
}
