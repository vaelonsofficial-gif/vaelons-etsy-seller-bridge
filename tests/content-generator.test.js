import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyGenerationError,
  contentCacheKey,
  normalizeContentCommand,
  normalizeTaskScope
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
