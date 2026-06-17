// Cross-page (site-wide) analysis over crawl records: duplicate detection,
// issue aggregation, and the tab/bucket model the UI renders.

// Add duplicate-title / duplicate-description / duplicate-H1 issues by grouping
// indexable pages with identical (normalized) values. Mutates records' issues.
export function findDuplicates(records) {
  const indexable = records.filter((r) => r.indexable && r.isHtml && r.status === 200);
  dupGroup(indexable, (r) => r.title?.text, 'Page Titles', 'Duplicate title');
  dupGroup(indexable, (r) => r.metaDescription?.text, 'Meta Description', 'Duplicate meta description');
  dupGroup(indexable, (r) => r.h1?.items?.[0], 'H1', 'Duplicate H1');
}

function dupGroup(records, keyFn, category, label) {
  const groups = new Map();
  for (const r of records) {
    const key = (keyFn(r) || '').trim().toLowerCase();
    if (!key) continue;
    (groups.get(key) || groups.set(key, []).get(key)).push(r);
  }
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    for (const r of group) {
      r.issues.push({ severity: 'warning', category, message: `${label} (shared by ${group.length} pages)` });
    }
  }
}

const SEVERITY_ORDER = { error: 0, warning: 1, notice: 2 };

// Roll up every issue across all pages, grouped by category, with counts.
export function aggregateIssues(records) {
  const byCategory = new Map();
  const counts = { error: 0, warning: 0, notice: 0 };
  for (const r of records) {
    for (const iss of r.issues) {
      counts[iss.severity] = (counts[iss.severity] || 0) + 1;
      const cat = byCategory.get(iss.category) || { category: iss.category, error: 0, warning: 0, notice: 0, items: [] };
      cat[iss.severity] = (cat[iss.severity] || 0) + 1;
      cat.items.push({ url: r.url, ...iss });
      byCategory.set(iss.category, cat);
    }
  }
  const categories = [...byCategory.values()].sort(
    (a, b) => b.error - a.error || b.warning - a.warning || b.notice - a.notice
  );
  return { counts, categories };
}

// Top-level numbers for the dashboard.
export function summarize(records, externalLinks = []) {
  const s = {
    total: records.length,
    html: 0, indexable: 0, nonIndexable: 0,
    ok: 0, redirect: 0, clientError: 0, serverError: 0, fetchError: 0,
    missingTitle: 0, missingDesc: 0, missingH1: 0, noindex: 0,
    withSchema: 0, schemaErrors: 0, imagesMissingAlt: 0,
    external: externalLinks.length,
    avgWords: 0, avgResponseMs: 0, maxDepth: 0,
  };
  let words = 0, ms = 0, msCount = 0;
  for (const r of records) {
    if (r.isHtml) s.html++;
    if (r.indexable) s.indexable++; else s.nonIndexable++;
    if (r.statusClass === 'ok') s.ok++;
    else if (r.statusClass === 'redirect') s.redirect++;
    else if (r.statusClass === 'client-error') s.clientError++;
    else if (r.statusClass === 'server-error') s.serverError++;
    else if (r.statusClass === 'error') s.fetchError++;
    if (r.isHtml && r.status === 200) {
      if (!r.title?.text) s.missingTitle++;
      if (!r.metaDescription?.text) s.missingDesc++;
      if (!r.h1?.count) s.missingH1++;
      if (/noindex/.test(r.metaRobots || '') || /noindex/.test(r.xRobots || '')) s.noindex++;
      if (r.schema?.itemCount) s.withSchema++;
      s.schemaErrors += r.schema?.errors || 0;
      s.imagesMissingAlt += r.images?.missingAltCount || 0;
      words += r.wordCount || 0;
    }
    if (r.responseMs != null) { ms += r.responseMs; msCount++; }
    if ((r.depth || 0) > s.maxDepth) s.maxDepth = r.depth;
  }
  const htmlPages = s.html || 1;
  s.avgWords = Math.round(words / htmlPages);
  s.avgResponseMs = msCount ? Math.round(ms / msCount) : 0;
  return s;
}

// Sort a record's own issues by severity for display.
export function sortIssues(issues) {
  return [...issues].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

// ---- CSV export -------------------------------------------------------------

const CSV_COLUMNS = [
  ['Address', (r) => r.url],
  ['Status Code', (r) => r.status],
  ['Status', (r) => r.statusClass],
  ['Indexability', (r) => (r.indexable ? 'Indexable' : 'Non-Indexable')],
  ['Indexability Reason', (r) => r.indexabilityReason || ''],
  ['Title', (r) => r.title?.text || ''],
  ['Title Length', (r) => r.title?.length ?? ''],
  ['Meta Description', (r) => r.metaDescription?.text || ''],
  ['Meta Desc Length', (r) => r.metaDescription?.length ?? ''],
  ['H1', (r) => r.h1?.items?.[0] || ''],
  ['H1 Count', (r) => r.h1?.count ?? ''],
  ['Word Count', (r) => r.wordCount ?? ''],
  ['Canonical', (r) => r.canonical || ''],
  ['Meta Robots', (r) => r.metaRobots || ''],
  ['Inlinks', (r) => r.inlinks ?? ''],
  ['Internal Outlinks', (r) => r.links?.internalCount ?? ''],
  ['External Outlinks', (r) => r.links?.externalCount ?? ''],
  ['Images Missing Alt', (r) => r.images?.missingAltCount ?? ''],
  ['Schema Items', (r) => r.schema?.itemCount ?? ''],
  ['Schema Errors', (r) => r.schema?.errors ?? ''],
  ['Response (ms)', (r) => r.responseMs ?? ''],
  ['Size (bytes)', (r) => r.bytes ?? ''],
  ['Depth', (r) => r.depth ?? ''],
  ['Issues', (r) => r.issues.length],
];

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(records) {
  const header = CSV_COLUMNS.map(([h]) => csvCell(h)).join(',');
  const rows = records.map((r) => CSV_COLUMNS.map(([, fn]) => csvCell(fn(r))).join(','));
  return [header, ...rows].join('\n');
}
