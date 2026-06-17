import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => readFile(path.join(__dirname, 'fixtures', name), 'utf8');

let extract, validate, validateAll, vocab;
before(async () => {
  globalThis.DOMParser = DOMParser;
  ({ extract } = await import('../public/extract.js'));
  ({ validate, validateAll } = await import('../public/validate.js'));
  vocab = JSON.parse(await readFile(path.join(__dirname, '..', 'public', 'schemaorg-vocab.json'), 'utf8'));
});

const hasMsg = (list, re) => list.some((e) => re.test(e.message));

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
  const product = jsonld.find((i) => i.types.includes('Product'));
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
