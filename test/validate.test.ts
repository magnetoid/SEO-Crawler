import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Correct path resolution depending on if we are running from dist/test/ or test/
const isDist = __dirname.includes('dist');
const fixturesDir = isDist ? path.join(__dirname, '..', '..', 'test', 'fixtures') : path.join(__dirname, 'fixtures');
const fx = (name: string) => readFile(path.join(fixturesDir, name), 'utf8');

let extract: any, validate: any, validateAll: any, vocab: any;
before(async () => {
  (globalThis as any).DOMParser = DOMParser;
  const extractModule = isDist ? await import('../../dist/public/extract.js' as any) : await import('../public/extract.js' as any);
  extract = extractModule.extract;
  
  const validateModule = isDist ? await import('../../dist/public/validate.js' as any) : await import('../public/validate.js' as any);
  validate = validateModule.validate;
  validateAll = validateModule.validateAll;
  
  const vocabPath = isDist ? path.join(__dirname, '..', '..', 'public', 'schemaorg-vocab.json') : path.join(__dirname, '..', 'public', 'schemaorg-vocab.json');
  vocab = JSON.parse(await readFile(vocabPath, 'utf8'));
});

const hasMsg = (list: any[], re: RegExp) => list.some((e) => re.test(e.message));

test('valid Article: no errors, recognized type, recommended props noted', async () => {
  const { jsonld } = extract(await fx('jsonld-good.html'));
  const { errors, passes } = validate(jsonld[0], vocab);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.ok(hasMsg(passes, /Recognized schema\.org type/i));
  assert.ok(hasMsg(passes, /has recommended "author"/i));
});

test('missing @type produces a structural error', () => {
  const item = { format: 'jsonld', types: [], props: { name: ['x'] }, context: 'https://schema.org', parseError: null };
  const { errors } = validate(item, vocab);
  assert.ok(hasMsg(errors, /Missing @type/i));
});

test('unknown property is flagged as a vocabulary warning', () => {
  const item = {
    format: 'jsonld', context: 'https://schema.org',
    types: ['Product'], props: { name: ['Widget'], offers: [{ __item: { types: ['Offer'], props: { price: ['1'], priceCurrency: ['USD'] } } }], notARealProp: ['x'] },
    parseError: null,
  };
  const { warnings } = validate(item, vocab);
  assert.ok(hasMsg(warnings, /notARealProp.*not a known schema\.org property/i));
});

test('Product without offers/review/aggregateRating triggers Rich Results error', () => {
  const item = { format: 'jsonld', context: 'https://schema.org', types: ['Product'], props: { name: ['Widget'] }, parseError: null };
  const { errors } = validate(item, vocab);
  assert.ok(hasMsg(errors, /at least one of offers, review, or aggregateRating/i));
});

test('Product with required name + offers passes Rich Results required checks', async () => {
  const { jsonld } = extract(await fx('jsonld-graph.html'));
  const product = jsonld.find((i: any) => i.types.includes('Product'));
  const { errors, passes } = validate(product, vocab);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.ok(hasMsg(passes, /has required "name"/i));
  assert.ok(hasMsg(passes, /satisfies/i));
});

test('broken JSON-LD yields a single structural error', async () => {
  const { jsonld } = extract(await fx('jsonld-broken.html'));
  const { errors } = validate(jsonld[0], vocab);
  assert.ok(hasMsg(errors, /invalid JSON/i));
});

test('validateAll rolls up totals across items', async () => {
  const { all } = extract(await fx('microdata.html'));
  const { reports, totals } = validateAll(all, vocab);
  assert.equal(reports.length, all.length);
  assert.equal(typeof totals.errors, 'number');
  assert.equal(typeof totals.warnings, 'number');
});

test('Performance benchmark: complex deep JSON-LD graph does not stack overflow and completes efficiently', () => {
  // Create a deep JSON-LD graph to test performance and stack safety
  let deepJson: any = { "@type": "Thing", "name": "Level 0" };
  let current = deepJson;
  for (let i = 1; i <= 200; i++) {
    current.about = { "@type": "Thing", "name": `Level ${i}` };
    current = current.about;
  }
  const item = {
    format: 'jsonld',
    types: ['Thing'],
    props: { about: [deepJson.about] },
    context: 'https://schema.org',
    parseError: null
  };
  
  const start = performance.now();
  const { errors, warnings } = validate(item, vocab);
  const duration = performance.now() - start;
  
  // It shouldn't crash, and should complete quickly
  assert.ok(duration < 100, `Validation took too long: ${duration}ms`);
});

test('Google Rich Results: DiscussionForumPosting recognizes required properties', () => {
  const item = {
    format: 'jsonld', context: 'https://schema.org',
    types: ['DiscussionForumPosting'],
    props: { author: [{ __item: { types: ['Person'], props: { name: ['Alice'] } } }] },
    parseError: null,
  };
  const { errors, passes } = validate(item, vocab);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.ok(hasMsg(passes, /has required "author"/i));
});
