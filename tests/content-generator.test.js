import test from 'node:test';
import assert from 'node:assert/strict';

import {
  automationClaimHash,
  classifyGenerationError,
  contentCacheKey,
  isAutomationClaimExpired,
  normalizeAutomationPayload,
  normalizeContentCommand,
  normalizeTaskScope,
  selectNextAutomationTask
} from '../lib/control-center/content-generator.js';

test('content command is normalized and bounded', () => {
  assert.equal(normalizeContentCommand('  SEO   içeriğini iyileştir  '), 'SEO içeriğini iyileştir');
  assert.throws(() => normalizeContentCommand('kısa'), (error) => error.code === 'COMMAND_TOO_SHORT');
  assert.throws(() => normalizeContentCommand('x'.repeat(21), 20), (error) => error.code === 'COMMAND_TOO_LONG');
});

test('task scope is allowlisted and defaults safely', () => {
  assert.equal(normalizeTaskScope('seo_content'), 'SEO_CONTENT');
  assert.equal(normalizeTaskScope('CREATIVE_IMAGES'), 'CREATIVE_IMAGES');
  assert.equal(normalizeTaskScope('publish_everything'), 'FULL_LISTING');
});

test('free queue cache keys are deterministic and scope-sensitive', () => {
  const input = {
    listingId: 1,
    beforeHash: 'abc',
    command: 'Optimize et',
    scope: 'SEO_CONTENT',
    engine: 'SEZAR_WORK_QUEUE'
  };
  assert.equal(contentCacheKey(input), contentCacheKey(input));
  assert.notEqual(contentCacheKey(input), contentCacheKey({ ...input, beforeHash: 'def' }));
  assert.notEqual(contentCacheKey(input), contentCacheKey({ ...input, scope: 'CREATIVE_IMAGES' }));
});

test('old Gateway billing records are converted into a removed-service notice', () => {
  const result = classifyGenerationError(new Error('AI Gateway requires a valid credit card on file'));
  assert.equal(result.code, 'LEGACY_GATEWAY_REMOVED');
  assert.equal(result.status, 410);
  assert.match(result.message, /ücretli bağlantı kaldırıldı/i);
  assert.doesNotMatch(result.message, /https?:\/\//);
});

test('internal queue errors keep their specific code and message', () => {
  const source = new Error('Bu listing için başka bir işlem devam ediyor');
  source.code = 'LISTING_LOCKED';
  source.status = 423;

  const result = classifyGenerationError(source);
  assert.equal(result.code, 'LISTING_LOCKED');
  assert.equal(result.status, 423);
  assert.equal(result.message, source.message);
});

test('automation claim hashes are deterministic and task-bound', () => {
  assert.equal(automationClaimHash('task-a', 'secret'), automationClaimHash('task-a', 'secret'));
  assert.notEqual(automationClaimHash('task-a', 'secret'), automationClaimHash('task-b', 'secret'));
});

test('automation selects the oldest queued metadata task and skips creative work', () => {
  const selected = selectNextAutomationTask([
    { id: 'new', status: 'QUEUED', task_scope: 'SEO_CONTENT', created_at: '2026-09-12T02:00:00Z' },
    { id: 'creative', status: 'QUEUED', task_scope: 'CREATIVE_IMAGES', created_at: '2026-09-12T00:00:00Z' },
    { id: 'old', status: 'QUEUED', task_scope: 'FULL_LISTING', created_at: '2026-09-12T01:00:00Z' }
  ]);
  assert.equal(selected.id, 'old');
});

test('expired background claims can be safely reclaimed', () => {
  const expired = {
    id: 'expired',
    status: 'IN_PROGRESS',
    task_scope: 'SEO_CONTENT',
    created_at: '2026-09-12T00:00:00Z',
    automation_claim_expires_at: '2026-09-12T00:55:00Z'
  };
  assert.equal(isAutomationClaimExpired(expired, Date.parse('2026-09-12T01:00:00Z')), true);
  assert.equal(selectNextAutomationTask([expired], Date.parse('2026-09-12T01:00:00Z')).id, 'expired');
});

test('automation payload is normalized and size-limited', () => {
  const payload = normalizeAutomationPayload({
    title: 'Title',
    tags: ['one', 'two'],
    description: 'Description',
    summary: '  concise\nsummary  '
  });
  assert.deepEqual(payload.tags, ['one', 'two']);
  assert.equal(payload.summary, 'concise summary');
  assert.throws(
    () => normalizeAutomationPayload({ title: 'T', tags: [], description: 'x'.repeat(13_000) }),
    (error) => error.code === 'AUTOMATION_PAYLOAD_TOO_LARGE'
  );
  assert.throws(
    () => normalizeAutomationPayload({ title: 'T', tags: [], description: 'x'.repeat(4_001) }),
    (error) => error.code === 'AUTOMATION_DESCRIPTION_TOO_LONG'
  );
});
