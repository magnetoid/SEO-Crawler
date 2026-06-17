import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let crawlSite, normalizeUrl, sameSite, analyzePage, vocab;
before(async () => {
  globalThis.DOMParser = DOMParser;
  ({ crawlSite, normalizeUrl, sameSite } = await import('../public/crawl.js'));
  ({ analyzePage } = await import('../public/seo.js'));
  vocab = JSON.parse(await readFile(path.join(__dirname, '..', 'public', 'schemaorg-vocab.json'), 'utf8'));
});

test('normalizeUrl drops hash, default port, trailing slash; lowercases host', () => {
  assert.equal(normalizeUrl('https://Site.test:443/a/#frag'), 'https://site.test/a');
  assert.equal(normalizeUrl('https://site.test/'), 'https://site.test/');
  assert.equal(normalizeUrl('https://site.test/b/'), 'https://site.test/b');
});

test('sameSite treats www and apex as the same site', () => {
  assert.equal(sameSite('https://www.site.test/a', 'https://site.test/b'), true);
  assert.equal(sameSite('https://site.test/a', 'https://other.test/b'), false);
});

// A tiny in-memory site for the crawler.
const SITE = {
  'https://site.test/': `<head><title>Home page title padding padding</title></head><body><h1>Home</h1>
    <a href="/a">A</a><a href="/b">B</a><a href="https://ext.test/x">ext</a></body>`,
  'https://site.test/a': `<head><title>Page A title padding padding padding</title></head><body><h1>A</h1>
    <a href="/b">B</a><a href="/">Home</a></body>`,
  'https://site.test/b': `<head><title>Page B title padding padding padding</title></head><body><h1>B</h1>
    <a href="/">Home</a><a href="/missing">Broken</a></body>`,
  'https://site.test/missing': null, // 404
};

function fakeFetch(url) {
  const key = url.endsWith('/') || url === 'https://site.test' ? 'https://site.test/' : url;
  const body = SITE[key];
  if (body == null) return Promise.resolve({ ok: true, status: 404, contentType: 'text/html', finalUrl: url, body: '', headers: {}, bytes: 0, elapsedMs: 5 });
  return Promise.resolve({ ok: true, status: 200, contentType: 'text/html', finalUrl: key, redirected: false, body, headers: {}, bytes: body.length, elapsedMs: 10 });
}

test('crawls the whole internal site, collects external links and inlinks', async () => {
  const { records, externalLinks, stats } = await crawlSite('https://site.test/', { maxPages: 50, concurrency: 3 }, {
    fetchPage: fakeFetch,
    analyze: (url, res) => analyzePage(url, res, vocab),
  });
  const urls = records.map((r) => normalizeUrl(r.finalUrl)).sort();
  // Home, A, B, and the broken /missing link (discovered + fetched -> 404).
  assert.deepEqual(urls, ['https://site.test/', 'https://site.test/a', 'https://site.test/b', 'https://site.test/missing']);

  const missing = records.find((r) => r.finalUrl.endsWith('/missing'));
  assert.equal(missing.status, 404);

  assert.deepEqual(externalLinks.map((e) => e.url), ['https://ext.test/x']);

  // /b is linked from home and /a -> at least 2 inlinks.
  const b = records.find((r) => r.finalUrl.endsWith('/b'));
  assert.ok(b.inlinks >= 2, `expected >=2 inlinks, got ${b.inlinks}`);
  assert.equal(stats.cancelled, false);
});

test('respects maxPages', async () => {
  const { records } = await crawlSite('https://site.test/', { maxPages: 2, concurrency: 1 }, {
    fetchPage: fakeFetch,
    analyze: (url, res) => analyzePage(url, res, vocab),
  });
  assert.equal(records.length, 2);
});
