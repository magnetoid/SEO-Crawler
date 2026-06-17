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

let extract: any;
before(async () => {
  // extract.js relies on a global DOMParser (provided by the browser at runtime).
  (globalThis as any).DOMParser = DOMParser;
  const extractModule = isDist ? await import('../../dist/public/extract.js' as any) : await import('../public/extract.js' as any);
  extract = extractModule.extract;
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
  const types = jsonld.flatMap((i: any) => i.types).sort();
  assert.deepEqual(types, ['Product', 'WebSite']);
  const product = jsonld.find((i: any) => i.types.includes('Product'));
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

test('Security: prevents JSON-LD prototype pollution', () => {
  const html = `
    <script type="application/ld+json">
    {
      "@type": "Thing",
      "@id": "__proto__",
      "name": "Polluted"
    }
    </script>
  `;
  const { jsonld } = extract(html);
  assert.equal(jsonld.length, 1);
  // Verify global Object prototype isn't polluted with an array from idMap['__proto__']
  assert.equal(({} as any).length, undefined);
  assert.equal((Object.prototype as any).length, undefined);
});

test('Security: prevents Microdata infinite recursion via itemref', () => {
  const html = `
    <div itemscope id="a" itemref="b" itemtype="https://schema.org/Thing">
      <span itemprop="name">A</span>
    </div>
    <div itemscope id="b" itemref="a" itemtype="https://schema.org/Thing">
      <span itemprop="name">B</span>
    </div>
  `;
  const { microdata } = extract(html);
  // Should complete without Maximum call stack size exceeded
  assert.equal(microdata.length, 2);
  assert.equal(microdata[0].types[0], 'Thing');
});
