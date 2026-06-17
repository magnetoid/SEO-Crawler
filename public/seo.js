// Per-page SEO analysis — the "tester" half of the spider.
//
// analyzePage(url, res, vocab) takes a URL and the proxy fetch result
// ({ status, contentType, finalUrl, redirected, location, headers, bytes,
// elapsedMs, body }) and returns a flat record describing the page plus a list
// of detected issues. Structured-data validation is folded in via extract.js /
// validate.js so schema is just another SEO dimension.
//
// Works in the browser (global DOMParser); in Node tests set globalThis.DOMParser.

import { extract } from './extract.js';
import { validateAll } from './validate.js';

// A canonical "points to self" if it resolves to the same site + path + query,
// ignoring trailing slashes, default ports, www, and the fragment.
function canonicalMatches(canon, finalUrl) {
  try {
    const a = new URL(canon), b = new URL(finalUrl);
    const norm = (p) => (p.replace(/\/+$/, '') || '/');
    return sameSite(canon, finalUrl) && norm(a.pathname) === norm(b.pathname) && a.search === b.search;
  } catch {
    return false;
  }
}

// Tunable thresholds (Screaming-Frog-like defaults).
export const LIMITS = {
  titleMax: 60, titleMin: 30,
  descMax: 160, descMin: 70,
  h1Max: 70,
  thinContent: 200,        // words
  slowMs: 1200,
  largeBytes: 2 * 1024 * 1024,
  urlMaxLen: 115,
};

function parseDoc(html) {
  const P = globalThis.DOMParser;
  if (!P) throw new Error('DOMParser is not available.');
  return new P().parseFromString(html || '', 'text/html');
}

const text = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');

// Resolve a possibly-relative href against the page URL; null if unparseable.
function resolve(href, base) {
  if (!href) return null;
  const h = href.trim();
  if (!h || h.startsWith('#') || /^(javascript|mailto|tel|data):/i.test(h)) return null;
  try { return new URL(h, base).href; } catch { return null; }
}

const hostOf = (u) => { try { return new URL(u).host.toLowerCase(); } catch { return ''; } };
// Same registrable site if hosts match ignoring a leading "www." on either side.
function sameSite(a, b) {
  const strip = (h) => h.replace(/^www\./, '');
  return strip(hostOf(a)) === strip(hostOf(b));
}

function wordCount(doc) {
  const body = doc.body;
  if (!body) return 0;
  // Remove non-content elements before counting.
  const clone = body.cloneNode(true);
  clone.querySelectorAll?.('script,style,noscript,template').forEach((n) => n.remove());
  const t = (clone.textContent || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

// Build the full analysis record for one fetched page.
export function analyzePage(requestedUrl, res, vocab) {
  const finalUrl = res.finalUrl || requestedUrl;
  const status = res.status ?? 0;
  const headers = res.headers || {};
  const contentType = res.contentType || headers['content-type'] || '';
  const isHtml = /html/i.test(contentType) || (!contentType && !!res.body);

  const rec = {
    url: requestedUrl,
    finalUrl,
    status,
    statusClass: statusClass(status),
    contentType,
    redirected: !!res.redirected,
    redirectTo: res.location ? resolve(res.location, finalUrl) : '',
    bytes: res.bytes || 0,
    responseMs: res.elapsedMs ?? null,
    isHtml,
    fetchError: res.ok === false ? res.error : null,
    issues: [],
    links: { internalCount: 0, externalCount: 0, internal: [], external: [] },
  };

  // Non-HTML or error responses: record status-level issues only.
  if (!res.ok) {
    rec.issues.push(issue('error', 'Response', `Fetch failed: ${res.error || 'unknown error'}`));
    rec.indexable = false;
    rec.indexabilityReason = 'Fetch error';
    return rec;
  }
  if (status >= 300 && status < 400) {
    rec.issues.push(issue('warning', 'Response Codes', `Redirect (${status}) to ${rec.redirectTo || '(no Location header)'}`));
  } else if (status >= 400 && status < 500) {
    rec.issues.push(issue('error', 'Response Codes', `Client error (${status}) — broken page`));
  } else if (status >= 500) {
    rec.issues.push(issue('error', 'Response Codes', `Server error (${status})`));
  }
  if (!isHtml) {
    rec.indexable = status === 200;
    rec.indexabilityReason = `Non-HTML (${contentType || 'unknown'})`;
    return rec;
  }
  // Full page analysis only applies to a 200 HTML response with a body.
  if (status !== 200 || !res.body) {
    rec.indexable = false;
    rec.indexabilityReason = `Non-200 (${status})`;
    return rec;
  }

  const doc = parseDoc(res.body);

  // ---- Title ----
  const titles = [...doc.querySelectorAll('head title, title')];
  const titleText = text(titles[0]);
  rec.title = { text: titleText, length: titleText.length, count: titles.length };

  // ---- Meta description ----
  const descs = [...doc.querySelectorAll('meta[name="description" i]')];
  const descText = (descs[0]?.getAttribute('content') || '').replace(/\s+/g, ' ').trim();
  rec.metaDescription = { text: descText, length: descText.length, count: descs.length };

  // ---- Headings ----
  const h1s = [...doc.querySelectorAll('h1')].map(text).filter(Boolean);
  const h2s = [...doc.querySelectorAll('h2')].map(text).filter(Boolean);
  rec.h1 = { count: h1s.length, items: h1s, firstLength: h1s[0]?.length || 0 };
  rec.h2 = { count: h2s.length, items: h2s.slice(0, 20) };

  // ---- Directives: robots, canonical, viewport, lang, charset ----
  const metaRobots = (doc.querySelector('meta[name="robots" i]')?.getAttribute('content') || '').toLowerCase();
  const xRobots = (headers['x-robots-tag'] || '').toLowerCase();
  rec.metaRobots = metaRobots;
  rec.xRobots = xRobots;
  const canonical = resolve(doc.querySelector('link[rel="canonical" i]')?.getAttribute('href'), finalUrl) || '';
  rec.canonical = canonical;
  rec.canonicalSelf = canonical ? canonicalMatches(canonical, finalUrl) : false;
  rec.viewport = !!doc.querySelector('meta[name="viewport" i]');
  rec.lang = doc.querySelector('html')?.getAttribute('lang') || '';
  rec.charset = doc.querySelector('meta[charset]')?.getAttribute('charset')
    || (doc.querySelector('meta[http-equiv="content-type" i]')?.getAttribute('content') || '').match(/charset=([\w-]+)/i)?.[1] || '';

  // ---- hreflang ----
  rec.hreflang = [...doc.querySelectorAll('link[rel="alternate" i][hreflang]')].map((l) => ({
    lang: l.getAttribute('hreflang'),
    href: resolve(l.getAttribute('href'), finalUrl) || l.getAttribute('href'),
  }));

  // ---- Social tags ----
  const metaProp = (sel, attr = 'content') => doc.querySelector(sel)?.getAttribute(attr) || '';
  rec.og = {
    title: metaProp('meta[property="og:title" i]'),
    description: metaProp('meta[property="og:description" i]'),
    image: metaProp('meta[property="og:image" i]'),
    type: metaProp('meta[property="og:type" i]'),
  };
  rec.twitter = { card: metaProp('meta[name="twitter:card" i]') };

  // ---- Word count ----
  rec.wordCount = wordCount(doc);

  // ---- Images ----
  const imgs = [...doc.querySelectorAll('img')];
  const missingAlt = imgs.filter((im) => !(im.getAttribute('alt') || '').trim() && im.getAttribute('role') !== 'presentation');
  rec.images = { count: imgs.length, missingAlt: missingAlt.map((im) => im.getAttribute('src') || '').slice(0, 50), missingAltCount: missingAlt.length };

  // ---- Links ----
  const anchors = [...doc.querySelectorAll('a[href]')];
  const internal = [];
  const external = [];
  const seenInt = new Set();
  const seenExt = new Set();
  for (const a of anchors) {
    const abs = resolve(a.getAttribute('href'), finalUrl);
    if (!abs) continue;
    const rec2 = { href: abs.replace(/#.*$/, ''), text: text(a).slice(0, 80), nofollow: /\bnofollow\b/i.test(a.getAttribute('rel') || '') };
    if (sameSite(abs, finalUrl)) {
      if (!seenInt.has(rec2.href)) { seenInt.add(rec2.href); internal.push(rec2); }
    } else {
      if (!seenExt.has(rec2.href)) { seenExt.add(rec2.href); external.push(rec2); }
    }
  }
  rec.links = { internal, external, internalCount: internal.length, externalCount: external.length };

  // ---- Structured data (reuse the schema engine) ----
  const items = extract(res.body).all;
  const { reports, totals } = validateAll(items, vocab);
  rec.schema = {
    itemCount: items.length,
    types: [...new Set(items.flatMap((i) => i.types || []))],
    errors: totals.errors,
    warnings: totals.warnings,
    reports, // kept for the detail view
  };

  // ---- Indexability ----
  computeIndexability(rec);

  // ---- Derive issues ----
  deriveIssues(rec);

  return rec;
}

function computeIndexability(rec) {
  const noindex = /noindex/.test(rec.metaRobots) || /noindex/.test(rec.xRobots);
  if (noindex) { rec.indexable = false; rec.indexabilityReason = 'noindex directive'; return; }
  if (rec.status !== 200) { rec.indexable = false; rec.indexabilityReason = `Non-200 (${rec.status})`; return; }
  if (rec.canonical && !rec.canonicalSelf) { rec.indexable = false; rec.indexabilityReason = 'Canonicalised to another URL'; return; }
  rec.indexable = true; rec.indexabilityReason = 'Indexable';
}

function deriveIssues(rec) {
  const add = (sev, cat, msg) => rec.issues.push(issue(sev, cat, msg));
  const L = LIMITS;

  // Title
  if (!rec.title.text) add('error', 'Page Titles', 'Missing page title');
  else {
    if (rec.title.count > 1) add('warning', 'Page Titles', `Multiple <title> tags (${rec.title.count})`);
    if (rec.title.length > L.titleMax) add('warning', 'Page Titles', `Title too long (${rec.title.length} chars; aim ≤ ${L.titleMax})`);
    else if (rec.title.length < L.titleMin) add('notice', 'Page Titles', `Title short (${rec.title.length} chars; aim ≥ ${L.titleMin})`);
  }

  // Meta description
  if (!rec.metaDescription.text) add('warning', 'Meta Description', 'Missing meta description');
  else {
    if (rec.metaDescription.count > 1) add('warning', 'Meta Description', `Multiple meta descriptions (${rec.metaDescription.count})`);
    if (rec.metaDescription.length > L.descMax) add('notice', 'Meta Description', `Meta description long (${rec.metaDescription.length} chars; aim ≤ ${L.descMax})`);
    else if (rec.metaDescription.length < L.descMin) add('notice', 'Meta Description', `Meta description short (${rec.metaDescription.length} chars; aim ≥ ${L.descMin})`);
  }

  // Headings
  if (rec.h1.count === 0) add('warning', 'H1', 'Missing H1');
  else if (rec.h1.count > 1) add('warning', 'H1', `Multiple H1 tags (${rec.h1.count})`);
  if (rec.h1.firstLength > L.h1Max) add('notice', 'H1', `H1 long (${rec.h1.firstLength} chars)`);

  // Content
  if (rec.wordCount < L.thinContent) add('notice', 'Content', `Thin content (${rec.wordCount} words)`);

  // Images
  if (rec.images.missingAltCount > 0) add('warning', 'Images', `${rec.images.missingAltCount} image(s) missing alt text`);

  // Canonical
  if (!rec.canonical) add('notice', 'Canonicals', 'No canonical link');
  else if (!rec.canonicalSelf) add('notice', 'Canonicals', `Canonicalised to ${rec.canonical}`);

  // Directives
  if (/noindex/.test(rec.metaRobots) || /noindex/.test(rec.xRobots)) add('warning', 'Directives', 'noindex — page excluded from search');
  if (/nofollow/.test(rec.metaRobots)) add('notice', 'Directives', 'nofollow meta robots');

  // Technical
  if (!rec.viewport) add('warning', 'Technical', 'Missing viewport meta (mobile)');
  if (!rec.lang) add('notice', 'Technical', 'Missing <html lang>');
  if (!rec.charset) add('notice', 'Technical', 'Missing charset declaration');
  if (/^http:\/\//i.test(rec.finalUrl)) add('warning', 'Technical', 'Served over insecure HTTP');

  // Performance
  if (rec.responseMs != null && rec.responseMs > L.slowMs) add('notice', 'Performance', `Slow response (${rec.responseMs} ms)`);
  if (rec.bytes > L.largeBytes) add('notice', 'Performance', `Large page (${(rec.bytes / 1024 / 1024).toFixed(1)} MB)`);

  // URL hygiene
  urlIssues(rec.finalUrl).forEach((m) => add('notice', 'URL', m));

  // Structured data
  if (rec.schema.errors > 0) add('warning', 'Structured Data', `${rec.schema.errors} structured-data error(s)`);
}

export function urlIssues(u) {
  const out = [];
  let path = u;
  try { const x = new URL(u); path = x.pathname + x.search; } catch { /* keep raw */ }
  if (u.length > LIMITS.urlMaxLen) out.push(`URL long (${u.length} chars)`);
  if (/[A-Z]/.test(path)) out.push('URL contains uppercase characters');
  if (/_/.test(path)) out.push('URL contains underscores (hyphens preferred)');
  if (/\s|%20/.test(path)) out.push('URL contains spaces');
  if (/[^ -]/.test(path)) out.push('URL contains non-ASCII characters');
  return out;
}

function statusClass(status) {
  if (!status) return 'error';
  if (status < 300) return 'ok';
  if (status < 400) return 'redirect';
  if (status < 500) return 'client-error';
  return 'server-error';
}

function issue(severity, category, message) {
  return { severity, category, message };
}
