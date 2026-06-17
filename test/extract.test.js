import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fx = (name) => readFile(path.join(__dirname, 'fixtures', name), 'utf8');

let extract;
before(async () => {
  // extract.js relies on a global DOMParser (provided by the browser at runtime).
  globalThis.DOMParser = DOMParser;
  ({ extract } = await import('../public/extract.js'));
});

test('JSON-LD: parses a well-formed Article', async () => {
  const { jsonld } = extract(await fx('jsonld-good.html'));
  assert.equal(jsonld.length, 1);
  assert.deepEqual(jsonld[0].types, ['Article']);
  assert.equal(jsonld[0].parseError, null);
  assert.ok(jsonld[0].props.author, 'author prop captured');
  // Nested author is normalized into an item.
  assert.ok(jsonld[0].props.author[0].__item, 'author is a nested item');
  assert.deepEqual(jsonld[0].props.author[0].__item.types, ['Person']);
});

test('JSON-LD: captures invalid JSON as a parse error', async () => {
  const { jsonld } = extract(await fx('jsonld-broken.html'));
  assert.equal(jsonld.length, 1);
  assert.match(jsonld[0].parseError, /invalid JSON/i);
});

test('JSON-LD: flattens @graph into individual items', async () => {
  const { jsonld } = extract(await fx('jsonld-graph.html'));
  assert.equal(jsonld.length, 2);
  const types = jsonld.flatMap((i) => i.types).sort();
  assert.deepEqual(types, ['Product', 'WebSite']);
  const product = jsonld.find((i) => i.types.includes('Product'));
  assert.ok(product.props.offers[0].__item, 'offers nested item');
});

test('Microdata: extracts nested Product/Offer/AggregateRating', async () => {
  const { microdata } = extract(await fx('microdata.html'));
  assert.equal(microdata.length, 1);
  const p = microdata[0];
  assert.deepEqual(p.types, ['Product']);
  assert.equal(p.props.name[0], 'Microdata Widget');
  assert.equal(p.props.image[0], 'https://example.com/m.jpg');
  const offer = p.props.offers[0].__item;
  assert.deepEqual(offer.types, ['Offer']);
  assert.equal(offer.props.price[0], '29.99');
  assert.equal(offer.props.priceCurrency[0], 'USD');
});

test('RDFa: extracts a Recipe with nested NutritionInformation', async () => {
  const { rdfa } = extract(await fx('rdfa.html'));
  assert.equal(rdfa.length, 1);
  const r = rdfa[0];
  assert.deepEqual(r.types, ['Recipe']);
  assert.equal(r.props.name[0], 'RDFa Pancakes');
  assert.ok(r.props.nutrition[0].__item, 'nutrition nested item');
  assert.deepEqual(r.props.nutrition[0].__item.types, ['NutritionInformation']);
});
