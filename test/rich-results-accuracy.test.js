// Accuracy tests pinning the validator to current Google documentation,
// guarding against the over-strict rules that were corrected after a docs review.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let validate, vocab;
before(async () => {
  ({ validate } = await import('../public/validate.js'));
  vocab = JSON.parse(await readFile(path.join(__dirname, '..', 'public', 'schemaorg-vocab.json'), 'utf8'));
});

// Build a JSON-LD item in the normalized shape (props: name -> [values]).
function item(type, props = {}) {
  const norm = {};
  for (const [k, v] of Object.entries(props)) norm[k] = Array.isArray(v) ? v : [v];
  return { format: 'jsonld', context: 'https://schema.org', types: [type], props: norm, parseError: null };
}
const errs = (r) => r.errors.map((e) => e.message);
const hasErr = (r, re) => r.errors.some((e) => re.test(e.message));
const hasWarn = (r, re) => r.warnings.some((e) => re.test(e.message) || re.test(e.detail || ''));

test('Article has NO required properties (Google requires none)', () => {
  const r = validate(item('Article', {}), vocab);
  const richErrors = r.errors.filter((e) => e.layer === 'rich-results');
  assert.equal(richErrors.length, 0, JSON.stringify(richErrors));
});

test('Organization has NO required properties (not even name)', () => {
  const r = validate(item('Organization', {}), vocab);
  const richErrors = r.errors.filter((e) => e.layer === 'rich-results');
  assert.equal(richErrors.length, 0, JSON.stringify(richErrors));
});

test('JobPosting: remote job with applicantLocationRequirements (no jobLocation) passes', () => {
  const remote = item('JobPosting', {
    title: 'Engineer', description: 'desc', datePosted: '2026-01-01',
    hiringOrganization: { __item: { types: ['Organization'], props: { name: ['Acme'] } } },
    jobLocationType: 'TELECOMMUTE', applicantLocationRequirements: { __item: { types: ['Country'], props: { name: ['US'] } } },
  });
  const r = validate(remote, vocab);
  assert.ok(!hasErr(r, /jobLocation/), errs(r).join(' | '));
});

test('JobPosting: neither jobLocation nor applicantLocationRequirements errors', () => {
  const r = validate(item('JobPosting', {
    title: 'Engineer', description: 'desc', datePosted: '2026-01-01',
    hiringOrganization: { __item: { types: ['Organization'], props: { name: ['Acme'] } } },
  }), vocab);
  assert.ok(hasErr(r, /jobLocation/));
});

test('VideoObject without contentUrl or embedUrl errors', () => {
  const r = validate(item('VideoObject', { name: 'V', thumbnailUrl: 'https://x/t.jpg', uploadDate: '2026-01-01' }), vocab);
  assert.ok(hasErr(r, /contentUrl or embedUrl/));
});

test('VideoObject with embedUrl only passes', () => {
  const r = validate(item('VideoObject', { name: 'V', thumbnailUrl: 'https://x/t.jpg', uploadDate: '2026-01-01', embedUrl: 'https://x/e' }), vocab);
  assert.ok(!hasErr(r, /contentUrl or embedUrl/));
});

test('Offer with priceSpecification (no price) passes', () => {
  const r = validate(item('Offer', { priceSpecification: { __item: { types: ['PriceSpecification'], props: { price: ['9.99'], priceCurrency: ['USD'] } } } }), vocab);
  const richErrors = r.errors.filter((e) => e.layer === 'rich-results');
  assert.equal(richErrors.length, 0, JSON.stringify(richErrors));
});

test('Offer inside hasOfferCatalog/itemListElement is NOT a Google rich result — no price error', () => {
  // Organization → hasOfferCatalog → OfferCatalog → itemListElement → Offer (no price).
  // Google has no rich result for OfferCatalog, so price/priceCurrency must not be required.
  const offer = { __item: { types: ['Offer'], props: { itemOffered: [{ __item: { types: ['Service'], props: { name: ['Consulting'] } } }] } } };
  const r = validate(item('Organization', {
    name: 'Acme',
    hasOfferCatalog: { __item: { types: ['OfferCatalog'], props: { name: ['Services'], itemListElement: [offer] } } },
  }), vocab);
  assert.ok(!hasErr(r, /price/i), 'should not flag price on catalog Offers: ' + errs(r).join(' | '));
  assert.ok(hasWarn(r, /not a Google rich result/i), 'should add a soft note: ' + r.warnings.map((w) => w.message).join(' | '));
});

test('Question accepts suggestedAnswer (Q&A), not only acceptedAnswer', () => {
  const r = validate(item('Question', { name: 'Q?', suggestedAnswer: { __item: { types: ['Answer'], props: { text: ['A'] } } } }), vocab);
  assert.ok(!hasErr(r, /acceptedAnswer or suggestedAnswer/));
});

test('FAQPage surfaces the gov/health eligibility note as a warning', () => {
  const r = validate(item('FAQPage', { mainEntity: { __item: { types: ['Question'], props: { name: ['Q'] } } } }), vocab);
  assert.ok(hasWarn(r, /government and health/i));
});

test('Product still requires name + one of offers/review/aggregateRating', () => {
  const r = validate(item('Product', { name: 'W' }), vocab);
  assert.ok(hasErr(r, /at least one of offers, review, or aggregateRating/));
});

// schema.org rangeIncludes (target-type) validation — parity with validator.schema.org.
test('isPartOf pointing to a Service is an invalid target type (matches schema.org)', () => {
  const r = validate(item('WebPage', {
    name: 'Page',
    isPartOf: { __item: { types: ['Service'], props: { name: ['My Service'] } } },
  }), vocab);
  assert.ok(hasErr(r, /Service is not a known valid target type for the "isPartOf" property/), errs(r).join(' | '));
});

test('isPartOf pointing to a CreativeWork subtype (WebSite) is valid', () => {
  const r = validate(item('WebPage', {
    name: 'Page',
    isPartOf: { __item: { types: ['WebSite'], props: { name: ['Site'] } } },
  }), vocab);
  assert.ok(!hasErr(r, /target type/), errs(r).join(' | '));
});

test('range check ignores plain literal values (no false positive)', () => {
  const r = validate(item('WebPage', { name: 'Page', isPartOf: 'https://example.com/' }), vocab);
  assert.ok(!hasErr(r, /target type/), errs(r).join(' | '));
});

test('isPartOf via @id reference to a Service node is flagged (resolves @graph refs)', () => {
  // {"@id": "..."} collapses to a string; idMap resolves it to the referenced type.
  const it = item('SoftwareApplication', { name: 'App', isPartOf: 'https://x/#service' });
  it.idMap = { 'https://x/#service': ['Service'] };
  const r = validate(it, vocab);
  assert.ok(hasErr(r, /Service is not a known valid target type for the "isPartOf" property/), errs(r).join(' | '));
});

test('isPartOf via @id reference to a WebPage node is valid', () => {
  const it = item('WebPage', { name: 'P', isPartOf: 'https://x/#website' });
  it.idMap = { 'https://x/#website': ['WebSite'] };
  const r = validate(it, vocab);
  assert.ok(!hasErr(r, /target type/), errs(r).join(' | '));
});

test('plain URL string for isPartOf (not an @id in the graph) is treated as a literal URL', () => {
  const it = item('WebPage', { name: 'P', isPartOf: 'https://example.com/whole' });
  it.idMap = {}; // not a known node id
  const r = validate(it, vocab);
  assert.ok(!hasErr(r, /target type/), errs(r).join(' | '));
});

// Nested-entity validation — parity with Google validating the whole tree.
test('Product with a nested Offer missing price flags the offer (recursive)', () => {
  const r = validate(item('Product', {
    name: 'Pride and Prejudice', image: 'https://x/p.png', sku: 'PG-1342',
    offers: { __item: { types: ['Offer'], props: { priceCurrency: ['USD'], availability: ['https://schema.org/InStock'] } } },
  }), vocab);
  // The "offers" one-of on Product is satisfied, but the nested Offer itself misses price.
  assert.ok(hasErr(r, /offers → .*price/i), errs(r).join(' | '));
});

test('Product with a complete nested Offer (price + currency) has no offer price error', () => {
  const r = validate(item('Product', {
    name: 'Book', image: 'https://x/p.png',
    offers: { __item: { types: ['Offer'], props: { price: ['9.99'], priceCurrency: ['USD'], availability: ['https://schema.org/InStock'] } } },
  }), vocab);
  assert.ok(!hasErr(r, /offers → .*price/i), errs(r).join(' | '));
});

test('valid nested entities (author Person) do not trigger target-type errors', () => {
  const r = validate(item('Article', {
    headline: 'H', author: { __item: { types: ['Person'], props: { name: ['Jane'] } } },
    image: 'https://x/i.jpg', datePublished: '2026-01-01',
  }), vocab);
  assert.ok(!hasErr(r, /target type/), errs(r).join(' | '));
});
