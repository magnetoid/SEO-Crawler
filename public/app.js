// SEO Tester controller. Four input modes (Crawl, Single URL, Sitemap, Paste
// HTML) all produce SEO records (seo.js), which are rendered through one
// dashboard + tabbed table + detail drawer. Structured-data validation rides
// along inside each record.

import { analyzePage } from './seo.js';
import { crawlSite, checkStatuses } from './crawl.js';
import { findDuplicates, aggregateIssues, summarize, sortIssues, toCsv } from './report.js';
import { runPageSpeed, classifyScore } from './pagespeed.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const els = {
  status: $('#status'), runBtn: $('#run-btn'), stopBtn: $('#stop-btn'),
  dashboard: $('#dashboard'), views: $('#views'), results: $('#results'),
  schemaPage: $('#schema-page'), pagespeedPage: $('#pagespeed-page'),
  drawer: $('#drawer'), drawerBody: $('#drawer-body'), vocabVersion: $('#vocab-version'),
};

let vocab = null;
let activeTab = 'crawl';
const state = {
  records: [], summary: null, issues: null, externalLinks: [], statuses: null,
  view: 'all', filter: '', sort: { key: null, dir: 1 }, abort: null,
};

// --- setup --------------------------------------------------------------------

async function loadVocab() {
  try {
    const res = await fetch('schemaorg-vocab.json');
    vocab = await res.json();
    if (vocab.version) els.vocabVersion.textContent = vocab.version;
  } catch { vocab = null; }
}

function initTabs() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      activeTab = tab.dataset.tab;
      $$('.tab').forEach((t) => {
        const on = t === tab;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-selected', String(on));
      });
      $$('.tab-panel').forEach((p) => {
        const on = p.dataset.panel === activeTab;
        p.classList.toggle('is-active', on);
        p.hidden = !on;
      });
    });
  });
}

// --- fetching -----------------------------------------------------------------

async function proxyFetch(url, { follow = false } = {}) {
  try {
    const res = await fetch(`/api/fetch?url=${encodeURIComponent(url)}&follow=${follow ? 1 : 0}`);
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message, status: 0 };
  }
}

async function mapLimit(items, limit, worker, onProgress) {
  const results = new Array(items.length);
  let next = 0, done = 0;
  async function run() {
    while (next < items.length) {
      if (state.abort?.aborted) return;
      const i = next++;
      results[i] = await worker(items[i], i);
      onProgress?.(++done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

// --- sitemap helpers ----------------------------------------------------------

function parseSitemap(xmlText) {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const urls = $$('loc', doc).map((n) => n.textContent.trim()).filter(Boolean);
  return { urls, isIndex: !!$('sitemapindex', doc) };
}

async function collectSitemapUrls(xmlText, max) {
  let { urls, isIndex } = parseSitemap(xmlText);
  if (isIndex) {
    const pages = [];
    for (let i = 0; i < urls.length; i++) {
      setBusy(true, `Reading sitemap ${i + 1}/${urls.length}…`);
      try { pages.push(...parseSitemap((await proxyFetch(urls[i], { follow: true })).body || '').urls); }
      catch { /* skip */ }
      if (pages.length >= max) break;
    }
    urls = pages;
  }
  const deduped = [...new Set(urls)];
  return { urls: deduped.slice(0, max), truncated: deduped.length > max, total: deduped.length };
}

// --- run orchestration --------------------------------------------------------

function setBusy(busy, message = '') {
  els.runBtn.disabled = busy;
  els.stopBtn.hidden = !busy || activeTab !== 'crawl';
  els.status.textContent = message;
}

async function run() {
  els.results.innerHTML = '';
  els.dashboard.hidden = true;
  els.views.hidden = true;
  state.abort = new AbortController();
  try {
    if (activeTab === 'crawl') await runCrawl();
    else if (activeTab === 'url') await runUrl();
    else if (activeTab === 'sitemap') await runSitemap();
    else await runHtml();
  } catch (err) {
    renderError(err.message);
  } finally {
    setBusy(false, '');
  }
}

async function runCrawl() {
  const start = $('#crawl-url').value.trim();
  if (!start) return renderError('Enter a start URL.');
  const maxPages = clampInt($('#crawl-max').value, 1, 100000, 100);
  const maxDepth = clampInt($('#crawl-depth').value, 0, 100, 10);
  const concurrency = clampInt($('#crawl-conc').value, 1, 10, 5);
  setBusy(true, 'Crawling…');

  const { records, externalLinks, stats } = await crawlSite(start, {
    maxPages, maxDepth, concurrency, signal: state.abort.signal,
    onProgress: ({ done, total }) => setBusy(true, `Crawled ${done} page(s), ${total} discovered…`),
  }, {
    fetchPage: (u) => proxyFetch(u, { follow: false }),
    analyze: (u, res) => analyzePage(u, res, vocab),
  });

  if ($('#crawl-ext').checked && externalLinks.length && !state.abort.signal.aborted) {
    setBusy(true, `Checking ${externalLinks.length} external link(s)…`);
    const { statuses } = await checkStatuses(externalLinks.map((e) => e.url),
      (u) => proxyFetch(u, { follow: true }), { signal: state.abort.signal });
    state.statuses = statuses;
  }
  finalize(records, externalLinks, stats);
}

async function runUrl() {
  const url = $('#url-input').value.trim();
  if (!url) return renderError('Enter a URL.');
  setBusy(true, `Fetching ${url} …`);
  const res = await proxyFetch(url, { follow: true });
  finalize([analyzePage(url, res, vocab)]);
}

async function runSitemap() {
  const max = optionalLimit($('#max-urls').value);
  const xmlInline = $('#sitemap-xml-input').value.trim();
  const sitemapUrl = $('#sitemap-url-input').value.trim();
  if (!xmlInline && !sitemapUrl) return renderError('Provide a sitemap URL or paste sitemap XML.');
  setBusy(true, 'Reading sitemap…');
  const xmlText = xmlInline || (await proxyFetch(sitemapUrl, { follow: true })).body || '';
  const { urls, truncated, total } = await collectSitemapUrls(xmlText, max);
  if (!urls.length) return renderError('No <loc> URLs found in the sitemap.');

  const records = await mapLimit(urls, 5, async (u) => analyzePage(u, await proxyFetch(u, { follow: false }), vocab),
    (done, t) => setBusy(true, `Audited ${done}/${t} pages…`));
  finalize(records.filter(Boolean), [], { note: truncated ? `Audited ${urls.length} of ${total} URLs.` : '' });
}

async function runHtml() {
  const html = $('#html-input').value.trim();
  if (!html) return renderError('Paste some HTML first.');
  setBusy(true, 'Analyzing…');
  const res = { ok: true, status: 200, contentType: 'text/html', finalUrl: 'https://pasted.local/', redirected: false, location: '', headers: {}, bytes: html.length, elapsedMs: 0, body: html };
  const rec = analyzePage('(pasted HTML)', res, vocab);
  finalize([rec]);
}

function finalize(records, externalLinks = [], extra = {}) {
  findDuplicates(records);
  state.records = records;
  state.externalLinks = externalLinks;
  state.summary = summarize(records, externalLinks);
  state.issues = aggregateIssues(records);
  state.view = 'all';
  state.filter = '';
  state.sort = { key: null, dir: 1 };
  state.note = extra.note || (extra.cancelled ? 'Crawl stopped early.' : '');
  if (extra && extra.cancelled) state.note = 'Crawl stopped — partial results.';
  renderAll();
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : Math.min(max, Math.max(min, n));
}
function optionalLimit(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) || n <= 0 ? Infinity : n;
}

// --- rendering: shell ---------------------------------------------------------

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

function renderError(message) {
  els.dashboard.hidden = true;
  els.views.hidden = true;
  els.schemaPage.hidden = true;
  els.results.hidden = false;
  els.results.innerHTML = '';
  els.results.append(el('div', 'notice error', message));
}

function renderAll() {
  if (!state.records.length) return renderError('No pages were analyzed.');
  showResults();
  renderDashboard();
  renderViews();
  renderView();
}

// Toggle between the results dashboard and a full-page sub-view (schema/pagespeed).
function showResults() {
  els.schemaPage.hidden = true;
  els.pagespeedPage.hidden = true;
  els.dashboard.hidden = false;
  els.views.hidden = false;
  els.results.hidden = false;
}
function showSubPage(sectionEl, contentNode) {
  els.dashboard.hidden = true;
  els.views.hidden = true;
  els.results.hidden = true;
  els.schemaPage.hidden = true;
  els.pagespeedPage.hidden = true;
  sectionEl.hidden = false;
  sectionEl.innerHTML = '';
  sectionEl.append(contentNode);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function showSchemaPage(rec) {
  showSubPage(els.schemaPage, renderSchemaPage(rec));
}
function showPageSpeedPage(rec) {
  showSubPage(els.pagespeedPage, renderPageSpeedPage(rec));
}

// --- rendering: dashboard -----------------------------------------------------

function renderDashboard() {
  const s = state.summary;
  els.dashboard.hidden = false;
  els.dashboard.innerHTML = '';
  const cards = [
    ['Pages', s.total],
    ['Indexable', s.indexable, 'pass'],
    ['Non-indexable', s.nonIndexable, s.nonIndexable ? 'warn' : null],
    ['Redirects', s.redirect, s.redirect ? 'warn' : null],
    ['4xx errors', s.clientError, s.clientError ? 'error' : null],
    ['5xx errors', s.serverError, s.serverError ? 'error' : null],
    ['Issues', state.issues.counts.error + state.issues.counts.warning + state.issues.counts.notice, (state.issues.counts.error ? 'error' : state.issues.counts.warning ? 'warn' : null)],
    ['With schema', s.withSchema],
    ['Avg words', s.avgWords],
    ['Avg resp.', s.avgResponseMs ? s.avgResponseMs + 'ms' : '—'],
  ];
  for (const [label, val, sev] of cards) els.dashboard.append(statCard(label, val, sev));
  if (state.note) els.dashboard.append(el('div', 'summary-note', state.note));
}

function statCard(label, value, severity) {
  const box = el('div', `stat${severity ? ' stat-' + severity : ''}`);
  box.append(el('span', 'stat-num', String(value)), el('span', 'stat-label', label));
  return box;
}

// --- rendering: view tabs -----------------------------------------------------

const VIEWS = [
  { id: 'all', label: 'All Pages' },
  { id: 'response', label: 'Response Codes' },
  { id: 'titles', label: 'Page Titles' },
  { id: 'desc', label: 'Meta Description' },
  { id: 'h1', label: 'Headings' },
  { id: 'images', label: 'Images' },
  { id: 'directives', label: 'Directives' },
  { id: 'schema', label: 'Structured Data' },
  { id: 'issues', label: 'Issues' },
  { id: 'external', label: 'External' },
];

function renderViews() {
  els.views.hidden = false;
  els.views.innerHTML = '';
  const bar = el('div', 'view-tabs');
  for (const v of VIEWS) {
    const count = viewCount(v.id);
    const b = el('button', `view-tab${state.view === v.id ? ' is-active' : ''}`);
    b.append(el('span', 'view-tab-label', v.label));
    if (count != null) b.append(el('span', 'view-tab-count', String(count)));
    b.addEventListener('click', () => { state.view = v.id; state.sort = { key: null, dir: 1 }; renderViews(); renderView(); });
    bar.append(b);
  }
  els.views.append(bar);

  const toolbar = el('div', 'view-toolbar');
  const search = el('input', 'view-search');
  search.type = 'search';
  search.placeholder = 'Filter by URL or text…';
  search.value = state.filter;
  search.addEventListener('input', () => { state.filter = search.value.toLowerCase(); renderView(); });
  toolbar.append(search);
  const csv = el('button', 'ghost', 'Export CSV');
  csv.addEventListener('click', downloadCsv);
  toolbar.append(csv);
  els.views.append(toolbar);
}

function viewCount(id) {
  if (id === 'issues') return state.issues.categories.reduce((a, c) => a + c.error + c.warning + c.notice, 0);
  if (id === 'external') return state.externalLinks.length;
  if (id === 'response') return state.records.filter((r) => r.statusClass !== 'ok').length || state.records.length;
  return filteredFor(id).length;
}

// --- rendering: views ---------------------------------------------------------

function renderView() {
  els.results.innerHTML = '';
  if (state.view === 'issues') return renderIssuesView();
  if (state.view === 'external') return renderExternalView();
  renderTable(state.view);
}

const COLUMNS = {
  all: [
    ['Address', (r) => urlCell(r), (r) => r.url],
    ['Status', (r) => statusCell(r), (r) => r.status],
    ['Indexability', (r) => indexCell(r), (r) => (r.indexable ? 1 : 0)],
    ['Title', (r) => textCell(r.title?.text), (r) => r.title?.text || ''],
    ['Words', (r) => numCell(r.wordCount), (r) => r.wordCount || 0],
    ['Inlinks', (r) => numCell(r.inlinks), (r) => r.inlinks || 0],
    ['Schema', (r) => schemaMini(r), (r) => r.schema?.itemCount || 0],
    ['Issues', (r) => issueMini(r), (r) => r.issues.length],
  ],
  response: [
    ['Address', (r) => urlCell(r), (r) => r.url],
    ['Status', (r) => statusCell(r), (r) => r.status],
    ['Type', (r) => textCell(r.statusClass), (r) => r.statusClass],
    ['Redirect / Final', (r) => textCell(r.redirectTo || r.finalUrl), (r) => r.redirectTo || ''],
  ],
  titles: [
    ['Address', (r) => urlCell(r), (r) => r.url],
    ['Title', (r) => textCell(r.title?.text || '(missing)'), (r) => r.title?.text || ''],
    ['Length', (r) => numCell(r.title?.length), (r) => r.title?.length || 0],
    ['Count', (r) => numCell(r.title?.count), (r) => r.title?.count || 0],
  ],
  desc: [
    ['Address', (r) => urlCell(r), (r) => r.url],
    ['Meta Description', (r) => textCell(r.metaDescription?.text || '(missing)'), (r) => r.metaDescription?.text || ''],
    ['Length', (r) => numCell(r.metaDescription?.length), (r) => r.metaDescription?.length || 0],
  ],
  h1: [
    ['Address', (r) => urlCell(r), (r) => r.url],
    ['H1', (r) => textCell(r.h1?.items?.[0] || '(missing)'), (r) => r.h1?.items?.[0] || ''],
    ['H1 Count', (r) => numCell(r.h1?.count), (r) => r.h1?.count || 0],
    ['H2 Count', (r) => numCell(r.h2?.count), (r) => r.h2?.count || 0],
  ],
  images: [
    ['Address', (r) => urlCell(r), (r) => r.url],
    ['Images', (r) => numCell(r.images?.count), (r) => r.images?.count || 0],
    ['Missing Alt', (r) => numCell(r.images?.missingAltCount), (r) => r.images?.missingAltCount || 0],
  ],
  directives: [
    ['Address', (r) => urlCell(r), (r) => r.url],
    ['Indexability', (r) => indexCell(r), (r) => (r.indexable ? 1 : 0)],
    ['Meta Robots', (r) => textCell(r.metaRobots || '—'), (r) => r.metaRobots || ''],
    ['Canonical', (r) => textCell(r.canonicalSelf ? 'self' : r.canonical || '—'), (r) => r.canonical || ''],
  ],
  schema: [
    ['Address', (r) => urlCell(r), (r) => r.url],
    ['Types', (r) => textCell((r.schema?.types || []).join(', ') || '—'), (r) => (r.schema?.types || []).join(',')],
    ['Items', (r) => numCell(r.schema?.itemCount), (r) => r.schema?.itemCount || 0],
    ['Errors', (r) => numCell(r.schema?.errors), (r) => r.schema?.errors || 0],
    ['Warnings', (r) => numCell(r.schema?.warnings), (r) => r.schema?.warnings || 0],
  ],
};

function filteredFor(view) {
  let recs = state.records;
  if (view === 'response') recs = recs; // show all, sorted by status
  if (view === 'schema') recs = recs.filter((r) => r.isHtml);
  const f = state.filter;
  if (f) recs = recs.filter((r) => (r.url + ' ' + (r.title?.text || '')).toLowerCase().includes(f));
  return recs;
}

function renderTable(view) {
  const cols = COLUMNS[view] || COLUMNS.all;
  let recs = filteredFor(view);
  if (state.sort.key != null) {
    const col = cols[state.sort.key];
    recs = [...recs].sort((a, b) => {
      const av = col[2](a), bv = col[2](b);
      if (av < bv) return -1 * state.sort.dir;
      if (av > bv) return 1 * state.sort.dir;
      return 0;
    });
  }
  const wrap = el('div', 'table-wrap');
  const table = el('table', 'data-table');
  const thead = el('thead');
  const htr = el('tr');
  cols.forEach(([head], i) => {
    const th = el('th', 'sortable', head);
    if (state.sort.key === i) th.classList.add(state.sort.dir === 1 ? 'sort-asc' : 'sort-desc');
    th.addEventListener('click', () => {
      state.sort = state.sort.key === i ? { key: i, dir: -state.sort.dir } : { key: i, dir: 1 };
      renderView();
    });
    htr.append(th);
  });
  thead.append(htr);
  table.append(thead);
  const tbody = el('tbody');
  const onRowClick = view === 'schema' ? showSchemaPage : openDrawer;
  for (const r of recs) {
    const tr = el('tr', 'data-row');
    tr.addEventListener('click', () => onRowClick(r));
    for (const [, cell] of cols) {
      const td = el('td');
      td.append(cell(r));
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  if (!recs.length) wrap.append(el('div', 'notice muted', 'No rows match.'));
  els.results.append(wrap);
}

function renderIssuesView() {
  const { categories } = state.issues;
  if (!categories.length) { els.results.append(el('div', 'notice pass-notice', 'No issues found. ')); return; }
  for (const cat of categories) {
    const card = el('div', 'issue-cat');
    const head = el('div', 'issue-cat-head');
    head.append(el('span', 'issue-cat-name', cat.category));
    if (cat.error) head.append(badge(`${cat.error} error`, 'error'));
    if (cat.warning) head.append(badge(`${cat.warning} warn`, 'warn'));
    if (cat.notice) head.append(badge(`${cat.notice} notice`, 'muted'));
    card.append(head);
    const ul = el('ul', 'issue-list');
    const items = state.filter ? cat.items.filter((i) => i.url.toLowerCase().includes(state.filter)) : cat.items;
    for (const it of items.slice(0, 200)) {
      const li = el('li', `issue-line sev-${it.severity}`);
      li.append(el('span', `dot dot-${it.severity}`));
      li.append(el('span', 'issue-msg', it.message));
      const a = el('a', 'issue-url', it.url);
      a.href = '#';
      a.addEventListener('click', (e) => { e.preventDefault(); const rec = state.records.find((r) => r.url === it.url); if (rec) openDrawer(rec); });
      li.append(a);
      ul.append(li);
    }
    if (items.length > 200) ul.append(el('li', 'issue-line', `…and ${items.length - 200} more`));
    card.append(ul);
    els.results.append(card);
  }
}

function renderExternalView() {
  if (!state.externalLinks.length) { els.results.append(el('div', 'notice muted', 'No external links found.')); return; }
  const wrap = el('div', 'table-wrap');
  const table = el('table', 'data-table');
  table.append((() => { const t = el('thead'); const tr = el('tr'); ['External URL', 'Linked From', 'Status'].forEach((h) => tr.append(el('th', null, h))); t.append(tr); return t; })());
  const tbody = el('tbody');
  let links = state.externalLinks;
  if (state.filter) links = links.filter((l) => l.url.toLowerCase().includes(state.filter));
  for (const link of links) {
    const tr = el('tr');
    const a = el('a', 'cell-link', link.url);
    a.href = link.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    const c1 = el('td'); c1.append(a);
    const c2 = el('td', null, String(link.sources.length));
    const st = state.statuses?.get(link.url);
    const c3 = el('td');
    if (st) c3.append(badge(String(st.status || 'ERR'), st.ok ? 'pass' : 'error'));
    else c3.append(document.createTextNode('—'));
    tr.append(c1, c2, c3);
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);
  els.results.append(wrap);
}

// --- cell renderers -----------------------------------------------------------

function urlCell(r) {
  const span = el('span', 'cell-url', shortenUrl(r.url));
  span.title = r.url;
  return span;
}
function shortenUrl(u) {
  try { const x = new URL(u); return (x.pathname + x.search) || '/'; } catch { return u; }
}
function statusCell(r) {
  return badge(String(r.status || 'ERR'), statusBadgeKind(r.statusClass));
}
function statusBadgeKind(cls) {
  return { ok: 'pass', redirect: 'warn', 'client-error': 'error', 'server-error': 'error', error: 'error' }[cls] || 'muted';
}
function indexCell(r) {
  const b = badge(r.indexable ? 'Indexable' : 'Non-indexable', r.indexable ? 'pass' : 'warn');
  b.title = r.indexabilityReason || '';
  return b;
}
function textCell(t) {
  const span = el('span', 'cell-text', t || '—');
  if (t) span.title = t;
  return span;
}
function numCell(n) { return el('span', 'cell-num', n == null ? '—' : String(n)); }
function schemaMini(r) {
  const wrap = el('span', 'cell-mini');
  if (!r.schema?.itemCount) { wrap.append(el('span', 'muted-text', '—')); return wrap; }
  wrap.append(el('span', 'mini-num', String(r.schema.itemCount)));
  if (r.schema.errors) wrap.append(badge(`${r.schema.errors}✗`, 'error'));
  return wrap;
}
function issueMini(r) {
  const wrap = el('span', 'cell-mini');
  const e = r.issues.filter((i) => i.severity === 'error').length;
  const w = r.issues.filter((i) => i.severity === 'warning').length;
  if (e) wrap.append(badge(String(e), 'error'));
  if (w) wrap.append(badge(String(w), 'warn'));
  if (!e && !w) wrap.append(el('span', 'muted-text', r.issues.length ? String(r.issues.length) : '✓'));
  return wrap;
}

// --- detail drawer ------------------------------------------------------------

function openDrawer(rec) {
  els.drawerBody.innerHTML = '';
  els.drawerBody.append(renderDetail(rec));
  els.drawer.hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeDrawer() {
  els.drawer.hidden = true;
  document.body.style.overflow = '';
}

function renderDetail(rec) {
  const box = el('div', 'detail');
  const head = el('div', 'detail-head');
  const a = el('a', 'detail-url', rec.url);
  if (/^https?:/.test(rec.url)) { a.href = rec.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  head.append(a);
  const tags = el('div', 'detail-tags');
  tags.append(statusCell(rec), indexCell(rec));
  if (rec.redirected && rec.redirectTo) tags.append(badge('→ ' + shortenUrl(rec.redirectTo), 'warn'));
  head.append(tags);
  box.append(head);

  // Key/value grid
  const grid = el('div', 'detail-grid');
  const kv = (k, v) => { const r = el('div', 'kv'); r.append(el('span', 'kv-k', k), el('span', 'kv-v', v == null || v === '' ? '—' : String(v))); grid.append(r); };
  kv('Title', rec.title ? `${rec.title.text || '(missing)'} (${rec.title.length})` : '—');
  kv('Meta description', rec.metaDescription ? `${rec.metaDescription.text || '(missing)'} (${rec.metaDescription.length})` : '—');
  kv('H1', rec.h1 ? `${rec.h1.items?.[0] || '(missing)'} (${rec.h1.count})` : '—');
  kv('Word count', rec.wordCount);
  kv('Canonical', rec.canonical ? (rec.canonicalSelf ? 'self-referencing' : rec.canonical) : '—');
  kv('Meta robots', rec.metaRobots || '—');
  kv('Indexability', rec.indexabilityReason);
  kv('Inlinks', rec.inlinks);
  kv('Outlinks', rec.links ? `${rec.links.internalCount} internal · ${rec.links.externalCount} external` : '—');
  kv('Response', rec.responseMs != null ? `${rec.responseMs} ms · ${(rec.bytes / 1024).toFixed(1)} KB` : '—');
  kv('Crawl depth', rec.depth);
  if (rec.lang || rec.viewport != null) kv('Lang / viewport', `${rec.lang || '—'} / ${rec.viewport ? 'yes' : 'no'}`);
  box.append(grid);

  // Issues
  if (rec.issues.length) {
    box.append(el('h3', 'detail-h', `Issues (${rec.issues.length})`));
    const ul = el('ul', 'detail-issues');
    for (const iss of sortIssues(rec.issues)) {
      const li = el('li', `issue-line sev-${iss.severity}`);
      li.append(el('span', `dot dot-${iss.severity}`));
      li.append(el('span', 'issue-cat-tag', iss.category));
      li.append(el('span', 'issue-msg', iss.message));
      ul.append(li);
    }
    box.append(ul);
  }

  // Headings
  if (rec.h1?.items?.length || rec.h2?.items?.length) {
    box.append(el('h3', 'detail-h', 'Headings'));
    const hl = el('div', 'headings');
    rec.h1?.items?.forEach((h) => { const d = el('div', 'heading-row'); d.append(badge('H1', 'muted'), el('span', null, h)); hl.append(d); });
    rec.h2?.items?.forEach((h) => { const d = el('div', 'heading-row'); d.append(badge('H2', 'muted'), el('span', null, h)); hl.append(d); });
    box.append(hl);
  }

  // Images missing alt
  if (rec.images?.missingAltCount) {
    box.append(el('h3', 'detail-h', `Images missing alt (${rec.images.missingAltCount})`));
    const ul = el('ul', 'detail-list');
    rec.images.missingAlt.forEach((src) => ul.append(el('li', null, src)));
    box.append(ul);
  }

  // Structured data — shown on its own page, not inline here.
  if (rec.schema?.itemCount) {
    box.append(el('h3', 'detail-h', 'Structured data'));
    const line = el('div', 'detail-schema-link');
    const summary = el('span', null, `${rec.schema.itemCount} item${rec.schema.itemCount === 1 ? '' : 's'}`
      + (rec.schema.types?.length ? ` · ${rec.schema.types.join(', ')}` : '')
      + (rec.schema.errors ? ` · ${rec.schema.errors} error${rec.schema.errors === 1 ? '' : 's'}` : ''));
    const btn = el('button', 'ghost', 'View structured data →');
    btn.addEventListener('click', () => { closeDrawer(); showSchemaPage(rec); });
    line.append(summary, btn);
    box.append(line);
  } else if (rec.isHtml) {
    box.append(el('h3', 'detail-h', 'Structured data'));
    box.append(el('div', 'notice muted', 'No JSON-LD, Microdata, or RDFa found on this page.'));
  }

  // PageSpeed / Core Web Vitals — runs a local Lighthouse audit on its own page.
  if (/^https?:/.test(rec.url)) {
    box.append(el('h3', 'detail-h', 'Performance'));
    const line = el('div', 'detail-schema-link');
    line.append(el('span', null, 'Core Web Vitals & PageSpeed (local Lighthouse)'));
    const btn = el('button', 'ghost', 'Run PageSpeed →');
    btn.addEventListener('click', () => { closeDrawer(); showPageSpeedPage(rec); });
    line.append(btn);
    box.append(line);
  }
  return box;
}

// --- full-page structured-data view ------------------------------------------

function renderSchemaPage(rec) {
  const page = el('div', 'schema-detail');
  const n = rec.schema?.itemCount || 0;

  const back = el('button', 'ghost back-btn', '← Back to results');
  back.addEventListener('click', showResults);
  page.append(back);

  // --- Main structure overview (leads the page) ---
  const hero = el('section', 'schema-hero');
  hero.append(el('div', 'schema-eyebrow', 'Page structure & structured data'));
  const url = el('a', 'schema-url', rec.url);
  if (/^https?:/.test(rec.url)) { url.href = rec.url; url.target = '_blank'; url.rel = 'noopener noreferrer'; }
  hero.append(url);
  hero.append(validatorActions(rec.url));
  page.append(hero);

  page.append(schemaOverview(rec));

  // --- Structured-data items ---
  const heading = el('h2', 'schema-section-big', `Structured data`);
  heading.append(el('span', 'schema-section-count', `${n} item${n === 1 ? '' : 's'}`));
  page.append(heading);

  if (!rec.schema?.reports?.length) {
    page.append(el('div', 'notice muted', 'No JSON-LD, Microdata, or RDFa found on this page.'));
    return page;
  }
  rec.schema.reports.forEach((report, i) => page.append(renderSchemaCard(report, i)));
  return page;
}

// One-click links to external validators for the page URL.
function validatorActions(url) {
  const wrap = el('div', 'schema-actions');
  if (!/^https?:\/\//.test(url)) {
    wrap.append(el('span', 'muted-text', 'External validator links are available when auditing a fetched URL (not pasted HTML).'));
    return wrap;
  }
  const enc = encodeURIComponent(url);
  wrap.append(linkButton(url, 'Open page', 'ghost'));
  wrap.append(linkButton(`https://search.google.com/test/rich-results?url=${enc}`, 'Google Rich Results Test ↗', 'action'));
  wrap.append(linkButton(`https://validator.schema.org/#url=${enc}`, 'Schema.org Validator ↗', 'action'));
  return wrap;
}
function linkButton(href, text, cls) {
  const a = el('a', `btn-link ${cls}`, text);
  a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer';
  return a;
}

// Prominent grid of the page's main parameters.
function schemaOverview(rec) {
  const ov = el('section', 'schema-overview');

  const tiles = el('div', 'ov-tiles');
  const tile = (label, value, sev) => {
    const t = el('div', `ov-tile${sev ? ' ov-' + sev : ''}`);
    t.append(el('div', 'ov-num', String(value)), el('div', 'ov-label', label));
    tiles.append(t);
  };
  tile('Status', rec.status || 'ERR', rec.statusClass === 'ok' ? 'pass' : 'warn');
  tile('Indexable', rec.indexable ? 'Yes' : 'No', rec.indexable ? 'pass' : 'warn');
  tile('Schema items', rec.schema?.itemCount || 0);
  tile('Errors', rec.schema?.errors || 0, rec.schema?.errors ? 'error' : null);
  tile('Warnings', rec.schema?.warnings || 0, rec.schema?.warnings ? 'warn' : null);
  tile('Words', rec.wordCount ?? '—');
  ov.append(tiles);

  const rows = el('div', 'ov-rows');
  const row = (k, v) => { const r = el('div', 'ov-row'); r.append(el('div', 'ov-row-k', k), el('div', 'ov-row-v', v)); rows.append(r); };
  if (rec.title) row('Title', `${rec.title.text || '(missing)'} · ${rec.title.length} chars`);
  if (rec.metaDescription) row('Meta description', `${rec.metaDescription.text || '(missing)'} · ${rec.metaDescription.length} chars`);
  if (rec.h1) row('H1', `${rec.h1.items?.[0] || '(missing)'} · ${rec.h1.count} on page`);
  if (rec.canonical !== undefined) row('Canonical', rec.canonicalSelf ? 'self-referencing' : (rec.canonical || '—'));
  if (rec.indexabilityReason) row('Indexability', rec.indexabilityReason);
  ov.append(rows);

  if (rec.schema?.types?.length) {
    const chips = el('div', 'ov-types');
    chips.append(el('span', 'ov-types-label', 'Types'));
    for (const t of rec.schema.types) chips.append(badge(t, 'muted'));
    ov.append(chips);
  }
  return ov;
}

// One structured-data item: type, data tree, validation findings, raw source.
function renderSchemaCard({ item, result }, index) {
  const card = el('div', 'schema-card');
  const head = el('div', 'item-head');
  head.append(el('span', 'schema-index', `#${index + 1}`));
  head.append(badge(formatLabel(item.format), 'format'));
  head.append(el('span', 'item-type', (item.types && item.types.join(', ')) || (item.parseError ? '(parse error)' : '(no type)')));
  head.append(badge(`${result.errors.length} err`, result.errors.length ? 'error' : 'muted'));
  head.append(badge(`${result.warnings.length} warn`, result.warnings.length ? 'warn' : 'muted'));
  card.append(head);

  for (const ti of result.typeInfo || []) {
    if (!ti.description) continue;
    const p = el('p', 'type-desc');
    p.append(el('strong', null, ti.type + ': '), document.createTextNode(ti.description + ' '), docLink(ti.docs, 'schema.org'));
    card.append(p);
  }

  // The data itself — readable property/value tree.
  if (item.props && Object.keys(item.props).length) {
    card.append(el('h4', 'schema-section', 'Data'));
    card.append(renderDataTree(item.props));
  } else if (item.parseError) {
    card.append(el('div', 'notice error', item.parseError));
  }

  // Validation findings.
  if (result.errors.length || result.warnings.length || result.passes.length) {
    card.append(el('h4', 'schema-section', 'Validation'));
    card.append(findingList(result.errors, 'error', 'Errors'));
    card.append(findingList(result.warnings, 'warn', 'Warnings'));
    card.append(findingList(result.passes, 'pass', 'Passed'));
  }

  // Raw source.
  if (item.source) {
    const d = el('details', 'source');
    d.append(el('summary', null, 'View raw source'), el('pre', null, item.source));
    card.append(d);
  }
  return card;
}

// Render a normalized item's props as a key/value tree (nested items recurse).
function renderDataTree(props) {
  const tree = el('div', 'data-tree');
  for (const [key, values] of Object.entries(props || {})) {
    const row = el('div', 'data-kv');
    row.append(el('div', 'data-key', key));
    const val = el('div', 'data-val');
    (Array.isArray(values) ? values : [values]).forEach((v) => val.append(renderDataValue(v)));
    row.append(val);
    tree.append(row);
  }
  return tree;
}

function renderDataValue(v) {
  if (v && typeof v === 'object') {
    const node = v.__item || (v.props ? v : null);
    if (node) {
      const block = el('div', 'data-nested');
      if (node.types?.length) block.append(el('span', 'data-nested-type', node.types.join(', ')));
      block.append(renderDataTree(node.props));
      return block;
    }
    return el('span', 'data-prim', JSON.stringify(v));
  }
  const s = String(v);
  if (/^https?:\/\//.test(s)) {
    const a = el('a', 'data-link', s);
    a.href = s; a.target = '_blank'; a.rel = 'noopener noreferrer';
    return a;
  }
  return el('span', 'data-prim', s);
}

// --- full-page PageSpeed / Core Web Vitals view -------------------------------

function renderPageSpeedPage(rec) {
  const page = el('div', 'ps-detail');
  const back = el('button', 'ghost back-btn', '← Back to results');
  back.addEventListener('click', showResults);
  page.append(back);

  const hero = el('section', 'schema-hero');
  hero.append(el('div', 'schema-eyebrow', 'PageSpeed & Core Web Vitals · local Lighthouse'));
  const url = el('a', 'schema-url', rec.url);
  url.href = rec.url; url.target = '_blank'; url.rel = 'noopener noreferrer';
  hero.append(url);

  const controls = el('div', 'schema-actions');
  const mk = (label, strat) => {
    const b = el('button', `btn-link ${strat === 'mobile' ? 'action' : 'ghost'}`, label);
    b.addEventListener('click', () => execRun(strat));
    return b;
  };
  controls.append(mk('Run · Mobile', 'mobile'), mk('Run · Desktop', 'desktop'));
  controls.append(linkButton(`https://pagespeed.web.dev/analysis?url=${encodeURIComponent(rec.url)}`, 'PageSpeed Insights ↗', 'ghost'));
  hero.append(controls);
  page.append(hero);

  const body = el('div', 'ps-body');
  body.append(el('div', 'notice muted', 'Choose Mobile or Desktop to run a local Lighthouse audit (headless Chrome). A run takes ~10-40s and shows real lab Core Web Vitals, the PageSpeed score, and prioritized fixes — no Google API needed.'));
  page.append(body);

  async function execRun(strategy) {
    body.innerHTML = '';
    body.append(el('div', 'ps-running', `Running Lighthouse (${strategy})… this can take up to ~40s.`));
    try {
      const result = await runPageSpeed(rec.url, strategy);
      body.innerHTML = '';
      body.append(renderPageSpeedResult(result));
    } catch (err) {
      body.innerHTML = '';
      body.append(el('div', 'notice error', err.message));
    }
  }
  return page;
}

function renderPageSpeedResult(r) {
  const wrap = el('div', 'ps-result');

  // Category gauges
  const gauges = el('div', 'ps-gauges');
  const gauge = (label, score) => {
    const cls = classifyScore(score);
    const g = el('div', `ps-gauge ps-${cls}`);
    g.append(el('div', 'ps-gauge-num', score == null ? '—' : String(score)));
    g.append(el('div', 'ps-gauge-label', label));
    gauges.append(g);
  };
  gauge('Performance', r.categories.performance);
  gauge('Accessibility', r.categories.accessibility);
  gauge('Best Practices', r.categories.bestPractices);
  gauge('SEO', r.categories.seo);
  wrap.append(gauges);
  wrap.append(el('div', 'ps-meta', `Lab data · Lighthouse ${r.lighthouseVersion || ''} · ${r.strategy} · scores 90+ good, 50-89 needs work, <50 poor`));

  // Core Web Vitals
  wrap.append(el('h3', 'ps-section', 'Core Web Vitals'));
  const cwv = el('div', 'ps-vitals');
  for (const key of ['lcp', 'inp', 'cls']) {
    const m = r.metrics[key];
    if (m) cwv.append(metricCard(m));
    else if (key === 'inp') cwv.append(inpFieldNote(r.metrics.tbt));
  }
  wrap.append(cwv);

  // Secondary lab metrics
  const secondary = ['tbt', 'fcp', 'si', 'ttfb', 'tti'].map((k) => r.metrics[k]).filter(Boolean);
  if (secondary.length) {
    wrap.append(el('h3', 'ps-section', 'Other lab metrics'));
    const grid = el('div', 'ps-vitals');
    secondary.forEach((m) => grid.append(metricCard(m)));
    wrap.append(grid);
  }

  // Opportunities + diagnostics
  if (r.opportunities.length) {
    wrap.append(el('h3', 'ps-section', `Opportunities (${r.opportunities.length})`));
    r.opportunities.forEach((a) => wrap.append(auditCard(a)));
  }
  if (r.diagnostics.length) {
    wrap.append(el('h3', 'ps-section', `Diagnostics (${r.diagnostics.length})`));
    r.diagnostics.forEach((a) => wrap.append(auditCard(a)));
  }
  if (!r.opportunities.length && !r.diagnostics.length) {
    wrap.append(el('div', 'notice pass-notice', 'No performance opportunities or diagnostics flagged — nice.'));
  }
  return wrap;
}

function metricCard(m) {
  const card = el('div', `ps-metric ps-${m.status}`);
  const head = el('div', 'ps-metric-head');
  head.append(el('span', 'ps-metric-abbr', m.abbr));
  head.append(el('span', 'ps-metric-val', m.displayValue || '—'));
  if (m.coreWebVital) head.append(badge('Core Web Vital', 'muted'));
  card.append(head);
  card.append(el('div', 'ps-metric-name', m.name));
  card.append(el('div', 'ps-metric-status', statusLabel(m.status)));
  card.append(el('p', 'ps-metric-what', m.what));
  const tipsWrap = el('details', 'ps-tips');
  tipsWrap.append(el('summary', null, 'How to improve'));
  const ul = el('ul');
  for (const t of m.tips || []) ul.append(el('li', null, t));
  tipsWrap.append(ul);
  card.append(tipsWrap);
  return card;
}

function inpFieldNote(tbt) {
  const card = el('div', 'ps-metric ps-na');
  const head = el('div', 'ps-metric-head');
  head.append(el('span', 'ps-metric-abbr', 'INP'));
  head.append(el('span', 'ps-metric-val', tbt ? tbt.displayValue + ' TBT' : '—'));
  head.append(badge('Field only', 'muted'));
  card.append(head);
  card.append(el('div', 'ps-metric-name', 'Interaction to Next Paint'));
  card.append(el('p', 'ps-metric-what', 'INP is a field (real-user) metric and is not measured in a lab run with no interactions. Total Blocking Time (TBT) above is the lab proxy — improve TBT to improve INP. Real INP needs Google CrUX / field data.'));
  return card;
}

function auditCard(a) {
  const card = el('div', 'ps-audit');
  const head = el('div', 'ps-audit-head');
  head.append(el('span', 'ps-audit-title', a.title));
  if (a.savingsMs) head.append(badge(`~${(a.savingsMs / 1000).toFixed(1)}s`, 'warn'));
  if (a.savingsBytes) head.append(badge(`${Math.round(a.savingsBytes / 1024)} KB`, 'warn'));
  if (a.displayValue && !a.savingsMs && !a.savingsBytes) head.append(badge(a.displayValue, 'muted'));
  card.append(head);
  if (a.why) card.append(el('p', 'ps-audit-why', a.why));
  else if (a.description) card.append(el('p', 'ps-audit-why', stripMd(a.description)));
  if (a.tips?.length) {
    const ul = el('ul', 'ps-audit-tips');
    for (const t of a.tips) ul.append(el('li', null, t));
    card.append(ul);
  }
  return card;
}

function statusLabel(status) {
  return { good: 'Good', 'needs-improvement': 'Needs improvement', poor: 'Poor', na: '—' }[status] || status;
}
function stripMd(s) {
  return String(s).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
}

// --- structured-data finding rendering (shared) -------------------------------

function findingList(items, severity, title) {
  if (!items || !items.length) return document.createComment('empty');
  const wrap = el('div', `findings findings-${severity}`);
  wrap.append(el('h4', 'findings-title', `${title} (${items.length})`));
  const ul = el('ul');
  for (const f of items) {
    const li = el('li');
    const hl = el('div', 'finding-head');
    hl.append(el('span', `layer-tag layer-${f.layer}`, layerLabel(f.layer)), el('span', 'finding-msg', f.message));
    li.append(hl);
    if (f.detail) li.append(el('div', 'finding-detail', f.detail));
    if (f.docs) { const dw = el('div', 'finding-docs'); dw.append(docLink(f.docs, f.layer === 'rich-results' ? 'Google documentation →' : 'schema.org reference →')); li.append(dw); }
    ul.append(li);
  }
  wrap.append(ul);
  return wrap;
}

// --- small helpers ------------------------------------------------------------

function badge(text, kind) { return el('span', `badge badge-${kind}`, text); }
function formatLabel(f) { return { jsonld: 'JSON-LD', microdata: 'Microdata', rdfa: 'RDFa' }[f] || f; }
function layerLabel(l) { return { structural: 'Structural', vocabulary: 'schema.org', 'rich-results': 'Rich Results' }[l] || l; }
function docLink(href, text) { const a = el('a', 'doc-link', text); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; return a; }

function downloadCsv() {
  const blob = new Blob([toCsv(state.records)], { type: 'text/csv' });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'seo-audit.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// --- init ---------------------------------------------------------------------

initTabs();
els.runBtn.addEventListener('click', run);
els.stopBtn.addEventListener('click', () => { state.abort?.abort(); setBusy(true, 'Stopping…'); });
$$('[data-close]').forEach((e) => e.addEventListener('click', closeDrawer));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !els.drawer.hidden) closeDrawer(); });
loadVocab();
