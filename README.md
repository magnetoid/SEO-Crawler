# SEO Tester

A small, self-hosted **SEO spider + structured-data validator** — a lightweight,
Screaming-Frog-style crawler that audits a whole site and tests each page against
on-page SEO best practices, schema.org, and Google Rich Results.

Four ways in:

- **Crawl Site** — give a start URL; the spider follows internal links breadth-first
  (with page/depth/concurrency limits) and audits every page.
- **Single URL** — fetch and audit one page.
- **Sitemap** — a `sitemap.xml` URL or pasted XML; audits the listed pages in bulk
  (handles sitemap-index files; blank limit = all pages).
- **Paste HTML** — audit raw markup with no fetching.

## What it tests

Per page: response code & redirects, indexability (+reason), title, meta description,
H1/H2, canonical, meta-robots / X-Robots-Tag directives, hreflang, viewport / lang /
charset, word count, images missing alt text, internal/external links, inlinks, response
time & size, URL hygiene, Open Graph, and **structured data** (JSON-LD, Microdata, RDFa —
validated against schema.org vocabulary and Google Rich Results requirements).

Site-wide: duplicate titles / meta descriptions / H1s, broken pages (4xx/5xx), redirects,
and an aggregated issue list grouped by category.

## Results UI

- A **dashboard** of headline numbers (pages, indexable, errors, issues, schema, averages).
- Tabbed, filterable, sortable **tables**: All Pages, Response Codes, Page Titles, Meta
  Description, Headings, Images, Directives, Structured Data, Issues, External.
- A per-URL **detail drawer** with every field, that page's issues, headings, images
  missing alt, and full structured-data findings (with fixes and doc links).
- **Export CSV** of the full crawl.

## How it works

- A tiny **Node server** (`server.js`, zero runtime dependencies) serves the page and
  exposes `GET /api/fetch?url=…&follow=0|1` as a fetch proxy (sidesteps CORS, captures
  redirects, headers, timing, and size). It blocks private/loopback addresses (SSRF guard)
  and caps response size.
- All crawling and analysis run **client-side** in vanilla JS using the browser's native
  `DOMParser`. No build step.
- Modules: [`crawl.js`](public/crawl.js) (BFS spider), [`seo.js`](public/seo.js) (per-page
  analysis), [`report.js`](public/report.js) (site-wide rollups + CSV),
  [`extract.js`](public/extract.js) + [`validate.js`](public/validate.js) +
  [`rich-results.js`](public/rich-results.js) (structured data), [`app.js`](public/app.js)
  (UI controller).

## PageSpeed & Core Web Vitals

On any fetched page, open its detail and **Run PageSpeed** for a Core Web Vitals + PageSpeed
report powered by **local Lighthouse** (headless Chrome) — **no Google API key, no rate limits**.
Shows Performance / Accessibility / Best Practices / SEO scores, the Core Web Vitals (LCP, CLS,
and TBT as the lab proxy for INP), secondary lab metrics, and prioritized opportunities &
diagnostics — each with a plain-language explanation and concrete fix tips. Toggle mobile/desktop.
This is **lab** data; real-user field CWV (and true INP) require Google CrUX and are out of scope.

Requires Google Chrome installed (used by `lighthouse` via `chrome-launcher`).

## Run

```bash
npm install        # deps: lighthouse + chrome-launcher (PageSpeed), linkedom (tests)
npm start          # serves http://localhost:4173
```

## Develop

```bash
npm test             # unit tests: crawl, seo, report, extract, validate, SSRF guard
npm run build-vocab  # refresh public/schemaorg-vocab.json from schema.org
```

## Accuracy

The validator is built to match the **current** schema.org and Google documentation, and
deliberately avoids false positives:

- **schema.org is non-constraining.** Per schema.org's own conformance docs, a property used
  outside its `domainIncludes` is still valid markup. The validator treats unknown/misplaced
  properties as **warnings, never errors**, walks the full `subClassOf` ancestor chain, unions
  allowed properties across multi-typed (`@type: [...]`) entities, and accepts `@id`-only
  reference nodes. It does **not** do strict value-type (`rangeIncludes`) enforcement, which is
  the biggest source of false positives.
- **`@context` is matched leniently** — `http`/`https`, trailing slash, and object/array
  contexts all accepted.
- **Google Rich Results rules** in [`rich-results.js`](public/rich-results.js) were verified
  against the live docs (2025-2026). Notably: Article and Organization have **no required
  properties**; `JobPosting.jobLocation` is not required for remote (`TELECOMMUTE`) jobs;
  `VideoObject` needs one of `contentUrl`/`embedUrl`; `Offer` accepts `priceSpecification`;
  `Question` accepts `suggestedAnswer` (Q&A) as well as `acceptedAnswer` (FAQ). Policy caveats
  are surfaced as advisory notes: **FAQ** rich results are limited to gov/health sites (Sep
  2023), **HowTo** rich results were removed (Sep 2023), and **Sitelinks Searchbox** was removed
  (Nov 2024).
- **Covered Rich Result features:** Article/NewsArticle/BlogPosting, Breadcrumb, Product, Offer,
  Review, AggregateRating, FAQPage, Question, QAPage, Recipe, Event, Organization, LocalBusiness,
  VideoObject, JobPosting, HowTo (deprecation note). Types outside this set still get full
  schema.org vocabulary validation; they just have no Google-specific rule layer.

## Updating the rules

- **schema.org vocabulary**: re-run `npm run build-vocab` (pulls the latest schema.org release).
- **Google Rich Results**: edit [`public/rich-results.js`](public/rich-results.js) — each entry
  cites its Google doc URL.
- **SEO thresholds** (title/description lengths, thin-content, slow-response, etc.):
  the `LIMITS` object in [`public/seo.js`](public/seo.js).

## Notes

- Crawling thousands of pages makes thousands of proxy fetches — it works, but be polite
  and mind rate limits. Use the page/depth caps, and the **Stop** button to end a crawl early.
- External-link status checking is opt-in (a crawl checkbox) and capped to avoid hammering
  third-party sites.
