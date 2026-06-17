import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let analyzePage, urlIssues, vocab;
before(async () => {
  globalThis.DOMParser = DOMParser;
  ({ analyzePage, urlIssues } = await import('../public/seo.js'));
  vocab = JSON.parse(await readFile(path.join(__dirname, '..', 'public', 'schemaorg-vocab.json'), 'utf8'));
});

const res = (body, extra = {}) => ({
  ok: true, status: 200, contentType: 'text/html', finalUrl: 'https://site.test/page',
  redirected: false, location: '', headers: {}, bytes: body.length, elapsedMs: 120, body, ...extra,
});

const hasIssue = (rec, re) => rec.issues.some((i) => re.test(i.message));

test('analyzes a well-formed page: title, meta, h1, links, indexable', () => {
  const html = `<!doctype html><html lang="en"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width">
    <title>A Good Page Title That Is Long Enough For SEO</title>
    <meta name="description" content="${'word '.repeat(20)}">
    <link rel="canonical" href="https://site.test/page">
  </head><body>
    <h1>The Main Heading</h1>
    <p>${'content '.repeat(120)}</p>
    <a href="/about">About</a><a href="/about">About dup</a>
    <a href="https://external.test/x">External</a>
    <img src="/a.jpg" alt="ok"><img src="/b.jpg">
  </body></html>`;
  const rec = analyzePage('https://site.test/page', res(html), vocab);
  assert.equal(rec.status, 200);
  assert.equal(rec.indexable, true);
  assert.match(rec.title.text, /Good Page Title/);
  assert.equal(rec.h1.count, 1);
  assert.equal(rec.links.internalCount, 1, 'duplicate /about deduped');
  assert.equal(rec.links.externalCount, 1);
  assert.equal(rec.images.missingAltCount, 1);
  assert.ok(hasIssue(rec, /missing alt/i));
  assert.ok(rec.wordCount > 100);
});

test('flags missing title, multiple H1, noindex, missing viewport', () => {
  const html = `<!doctype html><html><head>
    <meta name="robots" content="noindex,follow">
  </head><body>
    <h1>One</h1><h1>Two</h1>
  </body></html>`;
  const rec = analyzePage('https://site.test/page', res(html), vocab);
  assert.ok(hasIssue(rec, /Missing page title/i));
  assert.ok(hasIssue(rec, /Multiple H1/i));
  assert.ok(hasIssue(rec, /noindex/i));
  assert.ok(hasIssue(rec, /viewport/i));
  assert.equal(rec.indexable, false);
  assert.match(rec.indexabilityReason, /noindex/i);
});

test('detects canonicalisation to another URL as non-indexable', () => {
  const html = `<head><title>x title here padding padding padding</title>
    <link rel="canonical" href="https://site.test/other"></head><body><h1>h</h1></body>`;
  const rec = analyzePage('https://site.test/page', res(html), vocab);
  assert.equal(rec.canonicalSelf, false);
  assert.equal(rec.indexable, false);
  assert.match(rec.indexabilityReason, /canonical/i);
});

test('records redirects with target', () => {
  const rec = analyzePage('https://site.test/old', res('', {
    status: 301, redirected: true, location: 'https://site.test/new', body: '',
  }), vocab);
  assert.equal(rec.statusClass, 'redirect');
  assert.equal(rec.redirectTo, 'https://site.test/new');
  assert.ok(hasIssue(rec, /Redirect \(301\)/));
});

test('records 404 as a client error', () => {
  const rec = analyzePage('https://site.test/missing', res('', { status: 404, body: '' }), vocab);
  assert.equal(rec.statusClass, 'client-error');
  assert.ok(hasIssue(rec, /Client error \(404\)/));
});

test('folds structured-data validation into the record', () => {
  const html = `<head><title>Product page title padding padding padding</title></head><body><h1>P</h1>
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"W"}<\/script></body>`;
  const rec = analyzePage('https://site.test/p', res(html), vocab);
  assert.equal(rec.schema.itemCount, 1);
  assert.ok(rec.schema.types.includes('Product'));
  assert.ok(rec.schema.errors > 0, 'Product without offers/review/rating is an error');
  assert.ok(hasIssue(rec, /structured-data error/i));
});

test('urlIssues flags uppercase, underscores, length', () => {
  const out = urlIssues('https://site.test/Path_With_Underscores');
  assert.ok(out.some((m) => /uppercase/i.test(m)));
  assert.ok(out.some((m) => /underscore/i.test(m)));
});
