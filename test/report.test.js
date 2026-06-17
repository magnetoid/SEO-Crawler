import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findDuplicates, aggregateIssues, summarize, toCsv } from '../public/report.js';

// Minimal record factory matching seo.js output shape.
function rec(url, over = {}) {
  return {
    url, finalUrl: url, status: 200, statusClass: 'ok', isHtml: true, indexable: true,
    title: { text: 'T', length: 1, count: 1 }, metaDescription: { text: '', length: 0, count: 0 },
    h1: { items: ['H'], count: 1 }, h2: { items: [], count: 0 }, wordCount: 100,
    metaRobots: '', xRobots: '', schema: { itemCount: 0, errors: 0, warnings: 0, types: [] },
    images: { missingAltCount: 0 }, links: { internalCount: 0, externalCount: 0 },
    responseMs: 50, bytes: 1000, depth: 0, issues: [], ...over,
  };
}

test('findDuplicates flags shared titles and H1s', () => {
  const a = rec('https://s/a', { title: { text: 'Same', length: 4, count: 1 }, h1: { items: ['HX'], count: 1 } });
  const b = rec('https://s/b', { title: { text: 'Same', length: 4, count: 1 }, h1: { items: ['HY'], count: 1 } });
  const c = rec('https://s/c', { title: { text: 'Unique', length: 6, count: 1 }, h1: { items: ['HZ'], count: 1 } });
  findDuplicates([a, b, c]);
  assert.ok(a.issues.some((i) => /Duplicate title/.test(i.message)));
  assert.ok(b.issues.some((i) => /Duplicate title/.test(i.message)));
  assert.ok(!c.issues.some((i) => /Duplicate title/.test(i.message)));
});

test('aggregateIssues groups by category with counts', () => {
  const a = rec('https://s/a', { issues: [
    { severity: 'error', category: 'Response Codes', message: 'x' },
    { severity: 'warning', category: 'Images', message: 'y' },
  ] });
  const { counts, categories } = aggregateIssues([a]);
  assert.equal(counts.error, 1);
  assert.equal(counts.warning, 1);
  assert.equal(categories[0].category, 'Response Codes'); // errors sort first
});

test('summarize counts statuses, indexability, schema', () => {
  const a = rec('https://s/a', { schema: { itemCount: 2, errors: 1, warnings: 0, types: ['Product'] } });
  const b = rec('https://s/b', { statusClass: 'client-error', status: 404, indexable: false });
  const s = summarize([a, b], [{ url: 'https://ext/x' }]);
  assert.equal(s.total, 2);
  assert.equal(s.indexable, 1);
  assert.equal(s.clientError, 1);
  assert.equal(s.withSchema, 1);
  assert.equal(s.schemaErrors, 1);
  assert.equal(s.external, 1);
});

test('toCsv produces a header and one row per record, escaping commas', () => {
  const a = rec('https://s/a', { title: { text: 'Hello, world', length: 12, count: 1 } });
  const csv = toCsv([a]);
  const lines = csv.split('\n');
  assert.match(lines[0], /^Address,Status Code/);
  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes('"Hello, world"'), 'comma-containing field is quoted');
});
