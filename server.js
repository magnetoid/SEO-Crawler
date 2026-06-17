// Minimal zero-dependency server: serves public/ and proxies remote fetches
// so the browser SPA can crawl sitemaps and pages without hitting CORS.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT ? Number(process.env.PORT) : 4173;

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024; // 5 MB cap per fetched document
const FETCH_TIMEOUT_MS = 15000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// --- SSRF guard: only allow public http(s) hosts ------------------------------

// Returns an error string if the URL must be rejected, otherwise null.
export function rejectUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return 'Invalid URL.';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return 'Only http and https URLs are allowed.';
  }
  // URL keeps brackets around IPv6 literals (e.g. "[::1]"); strip them.
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  ) {
    return 'Refusing to fetch a local address.';
  }
  // IPv6 loopback / link-local / unique-local
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return 'Refusing to fetch a private address.';
  }
  // IPv4 private / loopback / link-local ranges
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (
      a === 127 ||
      a === 10 ||
      a === 0 ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31)
    ) {
      return 'Refusing to fetch a private address.';
    }
  }
  return null;
}

// Response headers the crawler/SEO analysis cares about (kept small).
const EXPOSED_HEADERS = ['content-type', 'content-length', 'x-robots-tag', 'location', 'last-modified', 'cache-control'];

// `follow`: when false, redirects are returned as-is (status 3xx + location)
// so the crawler can record and enqueue them — the way an SEO spider works.
async function proxyFetch(rawUrl, { follow = true } = {}) {
  const rejection = rejectUrl(rawUrl);
  if (rejection) return { ok: false, error: rejection };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(rawUrl, {
      redirect: follow ? 'follow' : 'manual',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; SeoTester/1.0; +seo-crawler-and-validator)',
        Accept: 'text/html,application/xhtml+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
      },
    });

    const headers = {};
    for (const h of EXPOSED_HEADERS) {
      const v = res.headers.get(h);
      if (v != null) headers[h] = v;
    }

    // Don't download bodies for redirects or obvious non-HTML payloads.
    const ctype = headers['content-type'] || '';
    const isRedirect = res.status >= 300 && res.status < 400;
    const isHtml = ctype.includes('html') || ctype.includes('xml') || ctype === '';
    let body = '';
    let bytes = Number(headers['content-length']) || 0;
    if (!isRedirect && isHtml) {
      const reader = res.body?.getReader();
      let received = 0;
      const chunks = [];
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          if (received > MAX_RESPONSE_BYTES) {
            reader.cancel();
            return { ok: false, error: 'Response exceeds 5 MB size limit.' };
          }
          chunks.push(value);
        }
      }
      const buf = Buffer.concat(chunks);
      bytes = buf.length;
      body = buf.toString('utf8');
    } else if (res.body) {
      try { await res.body.cancel(); } catch { /* ignore */ }
    }

    return {
      ok: true,
      status: res.status,
      contentType: ctype,
      finalUrl: res.url || rawUrl,
      redirected: res.redirected || isRedirect,
      location: headers['location'] || '',
      headers,
      bytes,
      elapsedMs: Date.now() - started,
      body,
    };
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'Request timed out.' : err.message;
    return { ok: false, error: `Fetch failed: ${msg}`, elapsedMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// --- PageSpeed / Core Web Vitals via local Lighthouse (no Google API) ---------

// Lighthouse drives a real headless Chrome and is resource-heavy, so runs are
// serialized through this promise chain (one Chrome instance at a time).
let lhLock = Promise.resolve();

function runLighthouseQueued(url, strategy) {
  const job = lhLock.then(() => doLighthouse(url, strategy));
  lhLock = job.catch(() => {}); // keep the chain alive even if a run fails
  return job;
}

async function doLighthouse(url, strategy) {
  const [{ default: lighthouse }, chromeLauncher] = await Promise.all([
    import('lighthouse'),
    import('chrome-launcher'),
  ]);
  const chrome = await chromeLauncher.launch({
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu'],
  });
  try {
    const desktop = strategy === 'desktop';
    const { lhr } = await lighthouse(url, {
      port: chrome.port,
      output: 'json',
      onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
      formFactor: desktop ? 'desktop' : 'mobile',
      screenEmulation: desktop
        ? { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false }
        : { mobile: true, width: 412, height: 823, deviceScaleFactor: 1.75, disabled: false },
    });
    return normalizeLhr(lhr, strategy);
  } finally {
    await chrome.kill();
  }
}

const METRIC_AUDITS = {
  lcp: 'largest-contentful-paint',
  cls: 'cumulative-layout-shift',
  tbt: 'total-blocking-time',
  fcp: 'first-contentful-paint',
  si: 'speed-index',
  tti: 'interactive',
  ttfb: 'server-response-time',
  inp: 'interaction-to-next-paint',
};

function normalizeLhr(lhr, strategy) {
  const cat = (k) => (lhr.categories[k] ? Math.round(lhr.categories[k].score * 100) : null);
  const metrics = {};
  for (const [key, id] of Object.entries(METRIC_AUDITS)) {
    const a = lhr.audits[id];
    metrics[key] = a ? { numericValue: a.numericValue ?? null, score: a.score, displayValue: a.displayValue || '' } : null;
  }
  const audits = [];
  for (const [id, a] of Object.entries(lhr.audits)) {
    if (a.score === null || a.score >= 1) continue;
    if (a.scoreDisplayMode === 'notApplicable' || a.scoreDisplayMode === 'manual') continue;
    const savingsMs = a.details?.overallSavingsMs || a.metricSavings?.LCP || 0;
    const isOpp = a.details?.type === 'opportunity' || savingsMs > 0;
    audits.push({
      id, title: a.title, description: a.description, score: a.score,
      scoreDisplayMode: a.scoreDisplayMode, displayValue: a.displayValue || '',
      numericValue: a.numericValue ?? null,
      savingsMs: Math.round(a.details?.overallSavingsMs || 0),
      savingsBytes: Math.round(a.details?.overallSavingsBytes || 0),
      itemCount: a.details?.items?.length || 0,
      kind: isOpp ? 'opportunity' : 'diagnostic',
    });
  }
  return {
    finalUrl: lhr.finalUrl || lhr.requestedUrl, fetchTime: lhr.fetchTime,
    lighthouseVersion: lhr.lighthouseVersion, strategy,
    categories: { performance: cat('performance'), accessibility: cat('accessibility'), bestPractices: cat('best-practices'), seo: cat('seo') },
    metrics, audits,
  };
}

// --- static file serving ------------------------------------------------------

function safeStaticPath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
  const resolved = path.join(PUBLIC_DIR, rel);
  // Prevent path traversal outside PUBLIC_DIR.
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    return null;
  }
  return resolved;
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/api/fetch') {
      const target = url.searchParams.get('url');
      if (!target) return sendJson(res, 400, { ok: false, error: 'Missing url parameter.' });
      const follow = url.searchParams.get('follow') !== '0';
      const result = await proxyFetch(target, { follow });
      // Always 200 at the transport layer; callers inspect `result.ok`. This
      // keeps a crawl of many failing URLs from flooding the browser console.
      return sendJson(res, 200, result);
    }

    if (url.pathname === '/api/lighthouse') {
      const target = url.searchParams.get('url');
      if (!target) return sendJson(res, 200, { ok: false, error: 'Missing url parameter.' });
      const rejection = rejectUrl(target);
      if (rejection) return sendJson(res, 200, { ok: false, error: rejection });
      const strategy = url.searchParams.get('strategy') === 'desktop' ? 'desktop' : 'mobile';
      try {
        const data = await runLighthouseQueued(target, strategy);
        return sendJson(res, 200, { ok: true, ...data });
      } catch (err) {
        return sendJson(res, 200, { ok: false, error: `Lighthouse run failed: ${err.message}` });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { ok: false, error: 'Method not allowed.' });
    }

    const filePath = safeStaticPath(url.pathname);
    if (!filePath) return sendJson(res, 403, { ok: false, error: 'Forbidden.' });

    try {
      const data = await readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      sendJson(res, 404, { ok: false, error: 'Not found.' });
    }
  });
}

// Only listen when run directly (so tests can import without binding a port).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(PORT, () => {
    console.log(`Schema Tester running at http://localhost:${PORT}`);
  });
}
