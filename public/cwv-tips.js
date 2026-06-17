// Curated Core Web Vitals & PageSpeed knowledge base — detailed explanations and
// concrete fix tips, distilled from web.dev / developer.chrome.com guidance.
// Used to augment Lighthouse's own audit descriptions with actionable advice.

// Core Web Vitals + key lab metrics. Thresholds are the official web.dev values
// ("good" / "poor" boundaries); numericUnit is how Lighthouse reports the value.
export const METRICS = {
  lcp: {
    name: 'Largest Contentful Paint', abbr: 'LCP', unit: 's', coreWebVital: true,
    good: 2500, poor: 4000, // ms
    what: 'Time until the largest content element (usually the hero image or headline block) is rendered in the viewport. It measures perceived load speed.',
    why: 'A core web vital. Users perceive a page as slow until the main content paints; slow LCP hurts rankings and bounce rate.',
    tips: [
      'Preload the LCP image: <link rel="preload" as="image" href="hero.jpg" fetchpriority="high">.',
      'Add fetchpriority="high" to the LCP <img>, and never set loading="lazy" on it — lazy-loading delays discovery.',
      'Cut server response time (TTFB): use a CDN, cache HTML, and avoid slow database/render work on the critical path.',
      'Serve modern, compressed image formats (AVIF/WebP) at the right dimensions; avoid shipping oversized images.',
      'Eliminate render-blocking CSS/JS before the LCP element; inline critical CSS and defer the rest.',
      'Preconnect to the origin that serves the LCP resource: <link rel="preconnect" href="https://cdn.example.com">.',
    ],
  },
  inp: {
    name: 'Interaction to Next Paint', abbr: 'INP', unit: 'ms', coreWebVital: true,
    good: 200, poor: 500,
    what: 'The longest delay between a user interaction (tap, click, keypress) and the next frame painted, across the whole visit. It measures responsiveness.',
    why: 'A core web vital (replaced FID in March 2024). High INP means the page feels janky and unresponsive to input.',
    fieldOnly: true,
    tips: [
      'Break up long tasks (>50 ms): chunk work and yield with await scheduler.yield() or setTimeout(0).',
      'Reduce main-thread JavaScript: code-split, tree-shake, defer/async non-critical scripts.',
      'Move heavy computation off the main thread into a Web Worker.',
      'Debounce/throttle high-frequency handlers (input, scroll, resize).',
      'Avoid layout thrashing — batch DOM reads, then writes; never interleave them in a handler.',
      'Keep interaction handlers light; defer non-urgent UI updates with requestIdleCallback / after the next paint.',
    ],
  },
  cls: {
    name: 'Cumulative Layout Shift', abbr: 'CLS', unit: '', coreWebVital: true,
    good: 0.1, poor: 0.25, unitless: true,
    what: 'A score for how much visible content unexpectedly shifts during the page\'s lifetime (impact fraction × distance fraction, worst session window).',
    why: 'A core web vital. Layout shifts cause mis-taps and a frustrating, unstable feel.',
    tips: [
      'Always set width and height (or CSS aspect-ratio) on <img>, <video>, <iframe> so space is reserved before they load.',
      'Reserve space for ads, embeds, and dynamically injected content with a min-height or aspect-ratio container.',
      'Never insert content above existing content (banners, notices) unless in response to a user interaction.',
      'Use font-display: optional (or preload fonts + a metrics-matched fallback) to avoid layout shift when web fonts swap.',
      'Animate with transform/opacity (compositor-only) instead of properties that trigger layout (top/left/width/height).',
    ],
  },
  tbt: {
    name: 'Total Blocking Time', abbr: 'TBT', unit: 'ms', good: 200, poor: 600,
    what: 'Total time between FCP and TTI where the main thread was blocked long enough (>50 ms tasks) to prevent input response. It is the lab proxy for INP.',
    why: 'A high TBT means long JavaScript tasks are monopolizing the main thread — the lab signal that real-user INP will be poor.',
    tips: [
      'Reduce and split JavaScript bundles; remove unused code.',
      'Break long tasks into smaller chunks and yield to the main thread.',
      'Defer third-party scripts (analytics, tag managers, chat widgets) until after load.',
      'Offload heavy work to Web Workers.',
    ],
  },
  fcp: {
    name: 'First Contentful Paint', abbr: 'FCP', unit: 's', good: 1800, poor: 3000,
    what: 'Time until the first text or image is painted.',
    why: 'First sign to the user that the page is loading; slow FCP usually means slow TTFB or render-blocking resources.',
    tips: [
      'Eliminate render-blocking CSS/JS; inline critical CSS.',
      'Improve TTFB (CDN, caching, faster server).',
      'Enable text compression (gzip/Brotli) and minify CSS/JS.',
    ],
  },
  si: {
    name: 'Speed Index', abbr: 'SI', unit: 's', good: 3400, poor: 5800,
    what: 'How quickly the visible parts of the page are populated during load.',
    why: 'A low Speed Index means above-the-fold content appears progressively and fast.',
    tips: [
      'Prioritize above-the-fold content and defer below-the-fold work.',
      'Reduce render-blocking resources and main-thread work.',
      'Optimize images and fonts on the critical path.',
    ],
  },
  ttfb: {
    name: 'Time to First Byte', abbr: 'TTFB', unit: 's', good: 800, poor: 1800,
    what: 'Time from navigation start until the first byte of the response arrives.',
    why: 'TTFB gates every other metric — a slow server delays FCP and LCP directly.',
    tips: [
      'Use a CDN and serve cached HTML from the edge.',
      'Optimize backend: cache database queries, reduce server-side rendering work.',
      'Use HTTP/2 or HTTP/3 and keep redirects to a minimum.',
    ],
  },
  tti: {
    name: 'Time to Interactive', abbr: 'TTI', unit: 's', good: 3800, poor: 7300,
    what: 'Time until the page is reliably able to respond to user input quickly.',
    why: 'Long TTI means users can see the page but interactions lag.',
    tips: ['Reduce and defer JavaScript.', 'Split long tasks.', 'Remove unused JS/CSS.'],
  },
};

// Per-audit guidance keyed by Lighthouse audit id: a short why + concrete fixes.
export const AUDITS = {
  'render-blocking-resources': { why: 'CSS/JS in the <head> blocks the browser from painting until it is fetched and processed, delaying FCP and LCP.', tips: ['Inline critical CSS in a <style> tag and load the rest asynchronously.', 'Add defer or async to non-critical <script> tags.', 'Use <link rel="preload"> + onload to load CSS without blocking.'] },
  'unused-javascript': { why: 'Downloading and parsing JavaScript that is never used wastes bandwidth and main-thread time.', tips: ['Code-split and lazy-load routes/components with dynamic import().', 'Tree-shake to drop unused exports.', 'Audit with the DevTools Coverage tab; remove dead dependencies.'] },
  'unused-css-rules': { why: 'Unused CSS still has to be downloaded and parsed, delaying render.', tips: ['Remove dead CSS (PurgeCSS / coverage tooling).', 'Split CSS per route and load only what the page needs.', 'Inline only the critical above-the-fold CSS.'] },
  'unminified-javascript': { why: 'Unminified JS ships unnecessary whitespace and comments.', tips: ['Enable minification in your bundler (esbuild/terser).', 'Serve minified production builds, not dev builds.'] },
  'unminified-css': { why: 'Unminified CSS is larger than it needs to be.', tips: ['Minify CSS in your build pipeline.', 'Enable your CDN/host’s automatic minification.'] },
  'modern-image-formats': { why: 'AVIF/WebP are far smaller than JPEG/PNG at equivalent quality.', tips: ['Serve AVIF or WebP with a <picture> fallback.', 'Use an image CDN that negotiates format automatically.'] },
  'uses-optimized-images': { why: 'Unoptimized images waste bytes and slow LCP.', tips: ['Compress images (Squoosh, ImageOptim, Sharp).', 'Target the right quality; avoid lossless for photos.'] },
  'uses-responsive-images': { why: 'Serving images larger than their display size wastes bandwidth.', tips: ['Use srcset and sizes to serve per-viewport dimensions.', 'Generate multiple resolutions at build time.'] },
  'offscreen-images': { why: 'Below-the-fold images that load eagerly compete with critical resources.', tips: ['Add loading="lazy" to below-the-fold images (never to the LCP image).', 'Lazy-load offscreen iframes too.'] },
  'uses-text-compression': { why: 'Text resources (HTML/CSS/JS) sent uncompressed are much larger over the wire.', tips: ['Enable Brotli (preferred) or gzip on the server/CDN.', 'Verify Content-Encoding: br/gzip on responses.'] },
  'server-response-time': { why: 'A slow initial server response (TTFB) delays everything downstream.', tips: ['Cache HTML at the edge / use a CDN.', 'Optimize backend queries and server-side rendering.', 'Use HTTP/2 or HTTP/3.'] },
  'uses-rel-preconnect': { why: 'Connecting to a new origin costs DNS + TCP + TLS round-trips.', tips: ['Add <link rel="preconnect"> for critical third-party origins (fonts, CDNs).', 'Use dns-prefetch for less-critical origins.'] },
  'uses-rel-preload': { why: 'Late-discovered critical resources delay render.', tips: ['Preload the LCP image, critical fonts, and key CSS.', 'Use fetchpriority="high" on the most important resource.'] },
  'preload-lcp-image': { why: 'The browser discovers the LCP image late, delaying LCP.', tips: ['Preload it with <link rel="preload" as="image" fetchpriority="high">.', 'Avoid lazy-loading or CSS background for the LCP element.'] },
  'prioritize-lcp-image': { why: 'The LCP image is not prioritized, so it loads after less important resources.', tips: ['Add fetchpriority="high" to the LCP <img>.', 'Preload it and remove loading="lazy".'] },
  'total-byte-weight': { why: 'Large total page weight slows load, especially on mobile networks.', tips: ['Compress and lazy-load images.', 'Split and defer JavaScript.', 'Remove unused assets and third-party scripts.'] },
  'dom-size': { why: 'A very large DOM increases memory, style, and layout costs, hurting interactivity.', tips: ['Reduce DOM node count; simplify deeply nested markup.', 'Virtualize long lists/tables (render only visible rows).', 'Avoid hidden-but-present heavy subtrees.'] },
  'third-party-summary': { why: 'Third-party scripts (ads, analytics, widgets) block the main thread and add latency.', tips: ['Defer or lazy-load third-party scripts.', 'Use facades for heavy embeds (e.g. click-to-load video).', 'Remove non-essential third parties; self-host where possible.'] },
  'bootup-time': { why: 'Time spent parsing, compiling, and executing JavaScript blocks the main thread.', tips: ['Ship less JS; code-split and lazy-load.', 'Defer non-critical scripts.', 'Replace heavy libraries with lighter alternatives.'] },
  'mainthread-work-breakdown': { why: 'Heavy script evaluation, style, layout, and paint work block interactivity.', tips: ['Reduce JavaScript execution and long tasks.', 'Minimize style recalculation and layout (avoid thrashing).', 'Offload work to Web Workers.'] },
  'font-display': { why: 'Web fonts that block text rendering cause invisible text (FOIT) and can shift layout.', tips: ['Set font-display: swap (or optional to minimize CLS).', 'Preload key fonts: <link rel="preload" as="font" crossorigin>.', 'Self-host fonts and subset them to needed glyphs.'] },
  'efficient-animated-content': { why: 'Animated GIFs are huge compared to video formats.', tips: ['Replace GIFs with MP4/WebM video.', 'Use <video autoplay muted loop playsinline> for looping animations.'] },
  'legacy-javascript': { why: 'Shipping transpiled legacy polyfills to modern browsers wastes bytes.', tips: ['Target modern baseline (ES2017+) for modern browsers.', 'Use module/nomodule or differential serving.'] },
  'duplicated-javascript': { why: 'The same module bundled multiple times inflates JS size.', tips: ['Deduplicate dependencies; align versions.', 'Use your bundler’s dedupe/optimization.'] },
  'largest-contentful-paint-element': { why: 'Identifies which element is the LCP — the thing to optimize first.', tips: ['Optimize this element’s resource (preload, compress, prioritize).', 'Ensure it is server-rendered and not blocked by JS.'] },
  'layout-shift-elements': { why: 'Identifies the elements contributing most to CLS.', tips: ['Reserve space for these elements (dimensions / aspect-ratio).', 'Avoid injecting them above existing content.'] },
  'uses-long-cache-ttl': { why: 'Short cache lifetimes force repeat downloads of static assets.', tips: ['Set long Cache-Control max-age for hashed/static assets.', 'Use immutable for fingerprinted files.'] },
  'redirects': { why: 'Each redirect adds a full round-trip before content loads.', tips: ['Link directly to final URLs.', 'Avoid chains (http→https→www→final); collapse to one hop.'] },
};

const GENERIC = { why: '', tips: ['Follow the Lighthouse guidance above and re-test after each change.'] };

export function tipsForMetric(key) { return METRICS[key] || null; }
export function tipsForAudit(id) { return AUDITS[id] || GENERIC; }
