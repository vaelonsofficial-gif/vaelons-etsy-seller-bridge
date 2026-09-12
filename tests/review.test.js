import test from 'node:test';
import assert from 'node:assert/strict';
import { isPendingReview, selectPendingReviews, verifiedTaskReceipts, revisionCommand } from '../lib/control-center/review.js';

const action = { id: 'draft-a', listing_id: 123, type: 'LISTING_METADATA_UPDATE', status: 'VALIDATED',
  qa: { passed: true }, etsy_modified: false, changed_fields: ['title'], proposed: { title: 'Swan Canvas Wall Art' }, created_at: '2026-09-12T12:00:00Z' };
const task = { id: 'task-a', listing_id: 123, task_scope: 'FULL_LISTING', status: 'COMPLETED',
  action_id: 'draft-a', etsy_modified: false, completed_at: '2026-09-12T12:00:10Z' };

test('review cards require validated metadata with explicit no-Etsy-write evidence', () => {
  assert.equal(isPendingReview(action), true);
  for (const patch of [{ status: 'BLOCKED' }, { qa: { passed: false } }, { etsy_modified: true },
    { etsy_modified: undefined }, { changed_fields: [] }, { changed_fields: ['price'] }, { type: 'CREATIVE_IMAGES' }]) {
    assert.equal(isPendingReview({ ...action, ...patch }), false);
  }
});

test('a newer blocked or published action hides an older review; unrelated actions do not', () => {
  const newer = { ...action, id: 'draft-b', created_at: '2026-09-12T13:00:00Z' };
  for (const status of ['BLOCKED', 'COMPLETED']) {
    assert.deepEqual(selectPendingReviews([action, { ...newer, status }]), []);
  }
  assert.deepEqual(selectPendingReviews([action, { ...newer, type: 'CREATIVE_IMAGES' }]), [action]);
  const input = [action, newer];
  assert.deepEqual(selectPendingReviews(input), [newer]);
  assert.deepEqual(input, [action, newer]);
});

test('completion receipts survive refresh using the matching persisted action', () => {
  assert.deepEqual(verifiedTaskReceipts([task], [action]), [{ task_id: 'task-a', listing_id: 123,
    generation_status: 'COMPLETED', action_id: 'draft-a', action_status: 'VALIDATED', etsy_modified: false }]);
});

test('receipt never trusts stale embedded actions, no-change completions, creative tasks or different listings', () => {
  assert.deepEqual(verifiedTaskReceipts([{ ...task, action }], []), []);
  assert.deepEqual(verifiedTaskReceipts([task], [{ ...action, status: 'COMPLETED', etsy_modified: true }]), []);
  for (const patch of [{ status: 'BLOCKED' }, { action_id: null }, { listing_id: 456 },
    { task_scope: 'CREATIVE_IMAGES' }, { etsy_modified: undefined }, { etsy_modified: true }]) {
    assert.deepEqual(verifiedTaskReceipts([{ ...task, ...patch }], [action]), []);
  }
});

test('revision feedback is bound to an editable proposal for the same listing and fits the queue limit', () => {
  assert.match(revisionCommand(action, '123', 'Başlığı biraz daha kısalt.'), /draft-a.*Başlığı biraz daha kısalt/);
  assert.ok(revisionCommand({ ...action, proposed: { title: 'T'.repeat(140) } }, '123', 'x'.repeat(800)).length <= 1200);
  assert.throws(() => revisionCommand(action, '456', 'Başlığı kısalt.'), { code: 'REVISION_NOT_AVAILABLE' });
  assert.throws(() => revisionCommand({ ...action, status: 'COMPLETED' }, '123', 'Başlığı kısalt.'), { code: 'REVISION_NOT_AVAILABLE' });
  assert.throws(() => revisionCommand(action, '123', 'kısa'), { code: 'REVISION_FEEDBACK_LENGTH' });
  assert.throws(() => revisionCommand(action, '123', 'x'.repeat(801)), { code: 'REVISION_FEEDBACK_LENGTH' });
});
