// Client side of the PageSpeed / Core Web Vitals feature. Calls the local
// Lighthouse endpoint, classifies metrics against web.dev thresholds, and
// attaches curated tips from cwv-tips.js.

import { METRICS, tipsForAudit } from './cwv-tips.js';

// Run a local Lighthouse audit via the server (headless Chrome — no Google API).
export async function runPageSpeed(url, strategy = 'mobile') {
  const res = await fetch(`/api/lighthouse?url=${encodeURIComponent(url)}&strategy=${strategy}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Lighthouse run failed.');
  return decorate(data);
}

// good | needs-improvement | poor for a metric value, using the metric's thresholds.
export function classifyMetric(key, numericValue) {
  const def = METRICS[key];
  if (!def || numericValue == null) return 'na';
  if (numericValue <= def.good) return 'good';
  if (def.poor != null && numericValue > def.poor) return 'poor';
  return 'needs-improvement';
}

export function classifyScore(score) {
  if (score == null) return 'na';
  if (score >= 90) return 'good';
  if (score >= 50) return 'needs-improvement';
  return 'poor';
}

// Attach metric definitions/status and audit tips to the raw normalized result.
function decorate(data) {
  const metrics = {};
  for (const [key, def] of Object.entries(METRICS)) {
    const m = data.metrics?.[key];
    if (!m) continue;
    metrics[key] = {
      key, ...def,
      numericValue: m.numericValue,
      displayValue: m.displayValue,
      status: classifyMetric(key, m.numericValue),
    };
  }
  const opportunities = [];
  const diagnostics = [];
  for (const a of data.audits || []) {
    const entry = { ...a, ...tipsForAudit(a.id) };
    (a.kind === 'opportunity' ? opportunities : diagnostics).push(entry);
  }
  opportunities.sort((a, b) => (b.savingsMs - a.savingsMs) || (b.savingsBytes - a.savingsBytes));
  diagnostics.sort((a, b) => a.score - b.score);
  return { ...data, metrics, opportunities, diagnostics };
}
