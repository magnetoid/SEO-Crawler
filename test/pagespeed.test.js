import { test, before } from 'node:test';
import assert from 'node:assert/strict';

let classifyMetric, classifyScore, METRICS, AUDITS, tipsForAudit;
before(async () => {
  ({ classifyMetric, classifyScore } = await import('../public/pagespeed.js'));
  ({ METRICS, AUDITS, tipsForAudit } = await import('../public/cwv-tips.js'));
});

test('classifyMetric uses web.dev thresholds for the core web vitals', () => {
  assert.equal(classifyMetric('lcp', 2000), 'good');        // ≤ 2.5s
  assert.equal(classifyMetric('lcp', 3200), 'needs-improvement');
  assert.equal(classifyMetric('lcp', 5000), 'poor');        // > 4s
  assert.equal(classifyMetric('cls', 0.05), 'good');        // ≤ 0.1
  assert.equal(classifyMetric('cls', 0.3), 'poor');         // > 0.25
  assert.equal(classifyMetric('inp', 150), 'good');         // ≤ 200ms
  assert.equal(classifyMetric('inp', 600), 'poor');         // > 500ms
});

test('classifyScore uses the 90/50 Lighthouse bands', () => {
  assert.equal(classifyScore(95), 'good');
  assert.equal(classifyScore(60), 'needs-improvement');
  assert.equal(classifyScore(30), 'poor');
  assert.equal(classifyScore(null), 'na');
});

test('every Core Web Vital metric has explanation + improvement tips', () => {
  for (const key of ['lcp', 'inp', 'cls']) {
    const m = METRICS[key];
    assert.ok(m, `metric ${key} defined`);
    assert.ok(m.coreWebVital, `${key} marked as CWV`);
    assert.ok(m.what && m.why, `${key} has what/why`);
    assert.ok(Array.isArray(m.tips) && m.tips.length >= 3, `${key} has tips`);
  }
});

test('all defined metrics carry thresholds and tips', () => {
  for (const [key, m] of Object.entries(METRICS)) {
    assert.equal(typeof m.good, 'number', `${key} good threshold`);
    assert.ok(m.tips.length >= 1, `${key} tips`);
  }
});

test('audit knowledge base entries have a why + concrete tips', () => {
  for (const [id, a] of Object.entries(AUDITS)) {
    assert.ok(a.why && a.why.length > 10, `${id} has a why`);
    assert.ok(Array.isArray(a.tips) && a.tips.length >= 1, `${id} has tips`);
  }
});

test('tipsForAudit returns a generic fallback for unknown audits', () => {
  const t = tipsForAudit('some-unknown-audit-id');
  assert.ok(Array.isArray(t.tips) && t.tips.length >= 1);
});
