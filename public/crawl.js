// Client-side BFS site crawler — the "spider" half.
//
// crawlSite(startUrl, options, deps) walks internal links breadth-first, fetching
// each URL through the proxy and handing the response to an analyzer. It enforces
// page/depth caps, runs a fixed number of fetches concurrently, records inlinks,
// follows internal redirects, and collects external links. It is cancelable.
//
// deps = {
//   fetchPage(url) -> Promise<proxyResult>   // GET via proxy, redirects NOT followed
//   analyze(url, res) -> record               // per-page SEO record (seo.js)
// }
// hooks (in options) = { onProgress({done,queued,total}), onPage(record), signal }

const DEFAULTS = { maxPages: 200, maxDepth: 10, concurrency: 5 };

// Canonicalize a URL for dedup: drop hash, lowercase host, drop default ports,
// strip a trailing slash (except root). Query string is kept.
export function normalizeUrl(u, base) {
  try {
    const x = new URL(u, base);
    x.hash = '';
    x.hostname = x.hostname.toLowerCase();
    if ((x.protocol === 'http:' && x.port === '80') || (x.protocol === 'https:' && x.port === '443')) x.port = '';
    if (x.pathname.length > 1) x.pathname = x.pathname.replace(/\/+$/, '');
    return x.href;
  } catch {
    return u;
  }
}

const stripWww = (h) => h.replace(/^www\./, '');
export function sameSite(a, b) {
  try {
    return stripWww(new URL(a).host.toLowerCase()) === stripWww(new URL(b).host.toLowerCase());
  } catch {
    return false;
  }
}

export async function crawlSite(startUrl, options = {}, deps) {
  const opts = { ...DEFAULTS, ...options };
  const { fetchPage, analyze } = deps;
  const { onProgress, onPage, signal } = options;

  const start = normalizeUrl(startUrl);
  const seen = new Set([start]);          // queued or visited (dedup gate)
  const visited = new Set();              // dequeued + processed
  const inlinks = new Map();              // url -> Set(source url)
  const externalLinks = new Map();        // url -> { sources: Set, nofollow }
  const records = [];
  const queue = [{ url: start, depth: 0 }];

  const addInlink = (target, source) => {
    if (!inlinks.has(target)) inlinks.set(target, new Set());
    if (source) inlinks.get(target).add(source);
  };

  const enqueue = (rawUrl, depth, source) => {
    const n = normalizeUrl(rawUrl);
    if (!sameSite(n, start)) return;
    addInlink(n, source);
    if (seen.has(n) || depth > opts.maxDepth) return;
    seen.add(n);
    queue.push({ url: n, depth });
  };

  const cancelled = () => signal?.aborted;

  await new Promise((resolveAll) => {
    let active = 0;
    let finished = false;

    const maybeDone = () => {
      if (!finished && active === 0 && (queue.length === 0 || visited.size >= opts.maxPages || cancelled())) {
        finished = true;
        resolveAll();
      }
    };

    const process = async (item) => {
      const res = await fetchPage(item.url);
      const rec = analyze(item.url, res);
      rec.depth = item.depth;
      records.push(rec);
      onPage?.(rec);
      onProgress?.({ done: visited.size, queued: queue.length, total: Math.min(seen.size, opts.maxPages) });

      // Internal redirect: record the edge and follow the target.
      if (rec.redirected && rec.redirectTo && sameSite(rec.redirectTo, start)) {
        enqueue(rec.redirectTo, item.depth, item.url);
      }
      // Internal links discovered on this page.
      for (const link of rec.links?.internal || []) {
        enqueue(link.href, item.depth + 1, item.url);
      }
      // External links: collect (status-checked later if requested).
      for (const link of rec.links?.external || []) {
        const entry = externalLinks.get(link.href) || { sources: new Set(), nofollow: link.nofollow };
        entry.sources.add(item.url);
        externalLinks.set(link.href, entry);
      }
    };

    const schedule = () => {
      while (active < opts.concurrency && queue.length && visited.size < opts.maxPages && !cancelled()) {
        const item = queue.shift();
        if (visited.has(item.url)) continue;
        visited.add(item.url);
        active++;
        process(item)
          .catch(() => {})
          .finally(() => {
            active--;
            schedule();
            maybeDone();
          });
      }
      maybeDone();
    };

    schedule();
  });

  // Attach inlink counts now that the whole graph is known.
  for (const rec of records) {
    rec.inlinks = inlinks.get(normalizeUrl(rec.url))?.size || 0;
  }

  return {
    records,
    inlinks,
    externalLinks: [...externalLinks.entries()].map(([url, v]) => ({ url, sources: [...v.sources], nofollow: v.nofollow })),
    stats: {
      crawled: records.length,
      reachedLimit: visited.size >= opts.maxPages,
      cancelled: !!cancelled(),
    },
  };
}

// Check the HTTP status of a list of URLs (e.g. external links) with a
// concurrency cap. Returns Map(url -> { status, ok, error }).
export async function checkStatuses(urls, fetchPage, { concurrency = 6, cap = 100, signal } = {}) {
  const list = urls.slice(0, cap);
  const out = new Map();
  let i = 0;
  async function worker() {
    while (i < list.length && !signal?.aborted) {
      const url = list[i++];
      try {
        const res = await fetchPage(url);
        out.set(url, { status: res.status, ok: res.ok && res.status < 400, error: res.error || null });
      } catch (err) {
        out.set(url, { status: 0, ok: false, error: err.message });
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return { statuses: out, checked: list.length, capped: urls.length > cap };
}
