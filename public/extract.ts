// Extract structured data from an HTML string into a uniform shape.
//
// Every detected item is normalized to:
//   {
//     format: 'jsonld' | 'microdata' | 'rdfa',
//     types:  [ 'Article', ... ],          // bare schema.org type names
//     props:  { name: [value, ...], ... },  // values are strings or nested items
//     raw:    <original parsed object | null>,
//     source: '<pretty-printed source for display>',
//     parseError: '<message>' | null        // JSON-LD blocks that failed to parse
//   }
//
// Works in the browser (global DOMParser) and in Node tests (set
// globalThis.DOMParser from linkedom before importing/calling).

import { Thing, WithContext } from 'schema-dts';

const SCHEMA_HOST = /^https?:\/\/schema\.org\//i;

// "https://schema.org/Article" | "schema:Article" | "Article" -> "Article"
export function bareType(value: any): string {
  if (typeof value !== 'string') return value;
  let v = value.trim();
  v = v.replace(SCHEMA_HOST, '').replace(/^schema:/, '');
  // For full itemtype URLs, keep the last path segment.
  if (/^https?:\/\//i.test(v)) v = v.split(/[/#]/).filter(Boolean).pop() || v;
  return v;
}

function typeList(value: any): string[] {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).map(bareType).filter(Boolean);
}

function getParser() {
  const P = (globalThis as any).DOMParser;
  if (!P) throw new Error('DOMParser is not available in this environment.');
  return new P();
}

export function parseDocument(html: string) {
  return getParser().parseFromString(html, 'text/html');
}

// --- JSON-LD ------------------------------------------------------------------

// Convert an arbitrary JSON-LD value into normalized props/types form.
function normalizeJsonLdNode(obj: any, depth = 0): any {
  if (depth > 50) return { types: [], props: {}, context: null }; // prevent stack overflow
  const types = typeList(obj['@type']);
  const props: any = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('@')) continue;
    props[key] = normalizeJsonLdValues(value, depth + 1);
  }
  return { types, props, context: obj['@context'] ?? null };
}

function normalizeJsonLdValues(value: any, depth: number): any[] {
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // A nested entity (has @type) becomes a nested item; otherwise keep object.
      if (v['@type']) return { __item: normalizeJsonLdNode(v, depth) };
      if (v['@value'] !== undefined) return v['@value'];
      if (v['@id'] !== undefined && Object.keys(v).length === 1) return v['@id'];
      return normalizeJsonLdNode(v, depth); // object without @type: still inspect props
    }
    return v;
  });
}

// Recursively index every @id -> [types] across a parsed JSON-LD value so that
// {"@id": "..."} references can be resolved to the node's type later (the way
// validator.schema.org resolves @graph references).
function indexIds(value: any, map: Record<string, string[]>) {
  if (Array.isArray(value)) {
    value.forEach((v) => indexIds(v, map));
  } else if (value && typeof value === 'object') {
    const id = value['@id'];
    const t = typeList(value['@type']);
    if (typeof id === 'string' && t.length) {
      map[id] = [...new Set([...(map[id] || []), ...t])];
    }
    for (const v of Object.values(value)) indexIds(v, map);
  }
}

function jsonLdItems(doc: Document) {
  const items: any[] = [];
  const idMap: Record<string, string[]> = Object.create(null); // @id -> [types], shared by reference across this document's items (safe from __proto__ pollution)
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  scripts.forEach((script: Element, index: number) => {
    const text = (script.textContent || '').trim();
    if (!text) return;
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch (err: any) {
      items.push({
        format: 'jsonld',
        types: [],
        props: {},
        raw: text.slice(0, 2000),
        source: text.slice(0, 4000),
        parseError: `Block #${index + 1}: invalid JSON — ${err.message}`,
      });
      return;
    }
    // A block may be a single object, an array, or carry a @graph of nodes.
    const roots: any[] = [];
    const collect = (node: any) => {
      if (Array.isArray(node)) node.forEach(collect);
      else if (node && typeof node === 'object') {
        if (Array.isArray(node['@graph'])) node['@graph'].forEach(collect);
        else roots.push(node);
      }
    };
    indexIds(parsed, idMap);
    collect(parsed);
    for (const root of roots) {
      const norm = normalizeJsonLdNode(root);
      items.push({
        format: 'jsonld',
        types: norm.types,
        props: norm.props,
        context: norm.context,
        raw: root,
        source: JSON.stringify(root, null, 2),
        idMap, // shared map for resolving @id references during validation
        parseError: null,
      });
    }
  });
  return mergeJsonLdById(items);
}

// Per JSON-LD 1.1, two node objects sharing the same @id are the SAME node, so a
// conforming processor (and Google) unions their properties rather than counting
// them twice. Pages often re-declare a site-wide node (e.g. #organization) in more
// than one <script>/@graph block; merge those so the entity count and per-entity
// property set match validator.schema.org and Google's parser.
function mergeJsonLdById(items: any[]): any[] {
  const out: any[] = [];
  const byId = new Map<string, number>(); // @id -> index in `out`
  for (const it of items) {
    const id = !it.parseError && it.raw && typeof it.raw['@id'] === 'string' ? it.raw['@id'] : null;
    if (id && byId.has(id)) {
      const target = out[byId.get(id)!];
      target.raw = mergeRawNodes(target.raw, it.raw);
      const norm = normalizeJsonLdNode(target.raw);
      target.types = norm.types;
      target.props = norm.props;
      target.context = norm.context ?? target.context;
      target.source = JSON.stringify(target.raw, null, 2);
      target.mergedCount = (target.mergedCount || 1) + 1;
    } else {
      it.mergedCount = 1;
      if (id) byId.set(id, out.length);
      out.push(it);
    }
  }
  return out;
}

// Union two raw JSON-LD node objects that share an @id: keep @id, union @type, and
// for every other property concatenate values (deduped by structural equality).
function mergeRawNodes(a: any, b: any): any {
  const toArr = (x: any) => (Array.isArray(x) ? x : [x]);
  const dedupe = (xs: any[]) => {
    const seen = new Set<string>();
    const result: any[] = [];
    for (const x of xs) {
      const key = JSON.stringify(x);
      if (!seen.has(key)) { seen.add(key); result.push(x); }
    }
    return result.length === 1 ? result[0] : result;
  };
  const out: any = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k === '@id') continue;
    if (k === '@context') { if (out[k] === undefined) out[k] = v; continue; }
    if (k === '@type') { out[k] = dedupe([...toArr(out[k] ?? []), ...toArr(v)]); continue; }
    if (out[k] === undefined) { out[k] = v; continue; }
    out[k] = dedupe([...toArr(out[k]), ...toArr(v)]);
  }
  return out;
}

// --- Microdata ----------------------------------------------------------------

function microdataItemFrom(scope: Element, doc: Document, visited = new Set<Element>()): any {
  if (visited.has(scope)) return { types: [], props: {} };
  visited.add(scope);
  
  const types = typeList(scope.getAttribute('itemtype'));
  const props: any = {};
  const add = (name: string, value: any) => {
    (props[name] ||= []).push(value);
  };

  // Collect itemprop elements belonging to this scope (not nested in a child scope).
  const propEls = collectScopedProps(scope, doc);
  for (const el of propEls) {
    const names = (el.getAttribute('itemprop') || '').split(/\s+/).filter(Boolean);
    let value;
    if (el.hasAttribute('itemscope')) {
      value = { __item: microdataItemFrom(el, doc, visited) };
    } else {
      value = microdataPropValue(el);
    }
    for (const n of names) add(n, value);
  }
  return { types, props };
}

// Elements with itemprop that are governed by `scope`: descendants of scope that
// are not separated from it by another itemscope, plus any referenced via itemref.
function collectScopedProps(scope: Element, doc: Document): Element[] {
  const result: Element[] = [];
  const walked = new Set<Element>();
  const walk = (node: Element) => {
    if (walked.has(node)) return;
    walked.add(node);
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const isProp = child.hasAttribute('itemprop');
      if (isProp) result.push(child);
      // Descend unless the child starts a new (nested) item without being a prop.
      if (!child.hasAttribute('itemscope')) walk(child);
    }
  };
  walk(scope);

  const refs = (scope.getAttribute('itemref') || '').split(/\s+/).filter(Boolean);
  for (const id of refs) {
    const el = doc.getElementById(id);
    if (el && el.hasAttribute('itemprop')) result.push(el);
  }
  return result;
}

function microdataPropValue(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el.hasAttribute('content')) return el.getAttribute('content') || '';
  if (tag === 'meta') return el.getAttribute('content') || '';
  if (tag === 'a' || tag === 'link' || tag === 'area') return el.getAttribute('href') || '';
  if (tag === 'img' || tag === 'source' || tag === 'iframe' || tag === 'embed')
    return el.getAttribute('src') || '';
  if (tag === 'time') return el.getAttribute('datetime') || (el.textContent || '').trim();
  if (tag === 'object') return el.getAttribute('data') || '';
  if (tag === 'data' || tag === 'meter') return el.getAttribute('value') || (el.textContent || '').trim();
  return (el.textContent || '').trim();
}

function microdataItems(doc: Document) {
  const items: any[] = [];
  // Top-level scopes only: an itemscope that is not itself an itemprop of a parent scope.
  const scopes = doc.querySelectorAll('[itemscope]');
  scopes.forEach((scope) => {
    if (scope.hasAttribute('itemprop')) return; // nested, captured by its parent
    if (hasAncestorScope(scope)) return;
    const norm = microdataItemFrom(scope, doc);
    items.push({
      format: 'microdata',
      types: norm.types,
      props: norm.props,
      raw: norm,
      source: prettyItem(norm),
      parseError: null,
    });
  });
  return items;
}

function hasAncestorScope(el: Element): boolean {
  let p = el.parentElement;
  while (p) {
    if (p.hasAttribute('itemscope')) return true;
    p = p.parentElement;
  }
  return false;
}

// --- RDFa (lightweight) -------------------------------------------------------

function rdfaItems(doc: Document) {
  const items: any[] = [];
  const scopes = doc.querySelectorAll('[typeof]');
  scopes.forEach((scope) => {
    if (rdfaHasAncestorScope(scope)) return; // nested, captured by parent
    const norm = rdfaItemFrom(scope);
    items.push({
      format: 'rdfa',
      types: norm.types,
      props: norm.props,
      raw: norm,
      source: prettyItem(norm),
      parseError: null,
    });
  });
  return items;
}

function rdfaHasAncestorScope(el: Element): boolean {
  let p = el.parentElement;
  while (p) {
    if (p.hasAttribute('typeof')) return true;
    p = p.parentElement;
  }
  return false;
}

function rdfaItemFrom(scope: Element, visited = new Set<Element>()): any {
  if (visited.has(scope)) return { types: [], props: {} };
  visited.add(scope);
  
  const types = typeList((scope.getAttribute('typeof') || '').split(/\s+/).filter(Boolean));
  const props: any = {};
  const add = (name: string, value: any) => {
    (props[name] ||= []).push(value);
  };
  const walk = (node: Element) => {
    for (let i = 0; i < node.children.length; i++) {
      const child = node.children[i];
      const propAttr = child.getAttribute('property');
      const startsItem = child.hasAttribute('typeof');
      if (propAttr) {
        const names = propAttr.split(/\s+/).filter(Boolean).map(bareType);
        const value = startsItem ? { __item: rdfaItemFrom(child, visited) } : rdfaPropValue(child);
        for (const n of names) add(n, value);
      }
      if (!startsItem) walk(child);
    }
  };
  walk(scope);
  return { types, props };
}

function rdfaPropValue(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (el.hasAttribute('content')) return el.getAttribute('content') || '';
  if (tag === 'a' || tag === 'link' || tag === 'area') return el.getAttribute('href') || '';
  if (tag === 'img') return el.getAttribute('src') || '';
  if (tag === 'time') return el.getAttribute('datetime') || (el.textContent || '').trim();
  return (el.textContent || '').trim();
}

// --- shared helpers -----------------------------------------------------------

// Render a normalized (microdata/rdfa) item into readable JSON for display.
function prettyItem(norm: any): string {
  const toPlain = (n: any): any => {
    const obj: any = {};
    if (n.types?.length) obj['@type'] = n.types.length === 1 ? n.types[0] : n.types;
    for (const [k, vals] of Object.entries(n.props || {})) {
      const mapped = (vals as any[]).map((v: any) => (v && v.__item ? toPlain(v.__item) : v));
      obj[k] = mapped.length === 1 ? mapped[0] : mapped;
    }
    return obj;
  };
  return JSON.stringify(toPlain(norm), null, 2);
}

// Main entry point.
export function extract(html: string) {
  const doc = parseDocument(html);
  const jsonld = jsonLdItems(doc);
  const microdata = microdataItems(doc);
  const rdfa = rdfaItems(doc);
  return {
    jsonld,
    microdata,
    rdfa,
    all: [...jsonld, ...microdata, ...rdfa],
  };
}
