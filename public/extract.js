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

const SCHEMA_HOST = /^https?:\/\/schema\.org\//i;

// "https://schema.org/Article" | "schema:Article" | "Article" -> "Article"
export function bareType(value) {
  if (typeof value !== 'string') return value;
  let v = value.trim();
  v = v.replace(SCHEMA_HOST, '').replace(/^schema:/, '');
  // For full itemtype URLs, keep the last path segment.
  if (/^https?:\/\//i.test(v)) v = v.split(/[/#]/).filter(Boolean).pop() || v;
  return v;
}

function typeList(value) {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).map(bareType).filter(Boolean);
}

function getParser() {
  const P = globalThis.DOMParser;
  if (!P) throw new Error('DOMParser is not available in this environment.');
  return new P();
}

export function parseDocument(html) {
  return getParser().parseFromString(html, 'text/html');
}

// --- JSON-LD ------------------------------------------------------------------

// Convert an arbitrary JSON-LD value into normalized props/types form.
function normalizeJsonLdNode(obj) {
  const types = typeList(obj['@type']);
  const props = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('@')) continue;
    props[key] = normalizeJsonLdValues(value);
  }
  return { types, props, context: obj['@context'] ?? null };
}

function normalizeJsonLdValues(value) {
  const arr = Array.isArray(value) ? value : [value];
  return arr.map((v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      // A nested entity (has @type) becomes a nested item; otherwise keep object.
      if (v['@type']) return { __item: normalizeJsonLdNode(v) };
      if (v['@value'] !== undefined) return v['@value'];
      if (v['@id'] !== undefined && Object.keys(v).length === 1) return v['@id'];
      return normalizeJsonLdNode(v); // object without @type: still inspect props
    }
    return v;
  });
}

// Recursively index every @id -> [types] across a parsed JSON-LD value so that
// {"@id": "..."} references can be resolved to the node's type later (the way
// validator.schema.org resolves @graph references).
function indexIds(value, map) {
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

function jsonLdItems(doc) {
  const items = [];
  const idMap = {}; // @id -> [types], shared by reference across this document's items
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  scripts.forEach((script, index) => {
    const text = (script.textContent || '').trim();
    if (!text) return;
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
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
    const roots = [];
    const collect = (node) => {
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
  return items;
}

// --- Microdata ----------------------------------------------------------------

function microdataItemFrom(scope, doc) {
  const types = typeList(scope.getAttribute('itemtype'));
  const props = {};
  const add = (name, value) => {
    (props[name] ||= []).push(value);
  };

  // Collect itemprop elements belonging to this scope (not nested in a child scope).
  const propEls = collectScopedProps(scope, doc);
  for (const el of propEls) {
    const names = (el.getAttribute('itemprop') || '').split(/\s+/).filter(Boolean);
    let value;
    if (el.hasAttribute('itemscope')) {
      value = { __item: microdataItemFrom(el, doc) };
    } else {
      value = microdataPropValue(el);
    }
    for (const n of names) add(n, value);
  }
  return { types, props };
}

// Elements with itemprop that are governed by `scope`: descendants of scope that
// are not separated from it by another itemscope, plus any referenced via itemref.
function collectScopedProps(scope, doc) {
  const result = [];
  const walk = (node) => {
    for (const child of node.children) {
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

function microdataPropValue(el) {
  const tag = el.tagName.toLowerCase();
  if (el.hasAttribute('content')) return el.getAttribute('content');
  if (tag === 'meta') return el.getAttribute('content') || '';
  if (tag === 'a' || tag === 'link' || tag === 'area') return el.getAttribute('href') || '';
  if (tag === 'img' || tag === 'source' || tag === 'iframe' || tag === 'embed')
    return el.getAttribute('src') || '';
  if (tag === 'time') return el.getAttribute('datetime') || (el.textContent || '').trim();
  if (tag === 'object') return el.getAttribute('data') || '';
  if (tag === 'data' || tag === 'meter') return el.getAttribute('value') || (el.textContent || '').trim();
  return (el.textContent || '').trim();
}

function microdataItems(doc) {
  const items = [];
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

function hasAncestorScope(el) {
  let p = el.parentElement;
  while (p) {
    if (p.hasAttribute('itemscope')) return true;
    p = p.parentElement;
  }
  return false;
}

// --- RDFa (lightweight) -------------------------------------------------------

function rdfaItems(doc) {
  const items = [];
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

function rdfaHasAncestorScope(el) {
  let p = el.parentElement;
  while (p) {
    if (p.hasAttribute('typeof')) return true;
    p = p.parentElement;
  }
  return false;
}

function rdfaItemFrom(scope) {
  const types = typeList((scope.getAttribute('typeof') || '').split(/\s+/).filter(Boolean));
  const props = {};
  const add = (name, value) => {
    (props[name] ||= []).push(value);
  };
  const walk = (node) => {
    for (const child of node.children) {
      const propAttr = child.getAttribute('property');
      const startsItem = child.hasAttribute('typeof');
      if (propAttr) {
        const names = propAttr.split(/\s+/).filter(Boolean).map(bareType);
        const value = startsItem ? { __item: rdfaItemFrom(child) } : rdfaPropValue(child);
        for (const n of names) add(n, value);
      }
      if (!startsItem) walk(child);
    }
  };
  walk(scope);
  return { types, props };
}

function rdfaPropValue(el) {
  const tag = el.tagName.toLowerCase();
  if (el.hasAttribute('content')) return el.getAttribute('content');
  if (tag === 'a' || tag === 'link' || tag === 'area') return el.getAttribute('href') || '';
  if (tag === 'img') return el.getAttribute('src') || '';
  if (tag === 'time') return el.getAttribute('datetime') || (el.textContent || '').trim();
  return (el.textContent || '').trim();
}

// --- shared helpers -----------------------------------------------------------

// Render a normalized (microdata/rdfa) item into readable JSON for display.
function prettyItem(norm) {
  const toPlain = (n) => {
    const obj = {};
    if (n.types?.length) obj['@type'] = n.types.length === 1 ? n.types[0] : n.types;
    for (const [k, vals] of Object.entries(n.props || {})) {
      const mapped = vals.map((v) => (v && v.__item ? toPlain(v.__item) : v));
      obj[k] = mapped.length === 1 ? mapped[0] : mapped;
    }
    return obj;
  };
  return JSON.stringify(toPlain(norm), null, 2);
}

// Main entry point.
export function extract(html) {
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
