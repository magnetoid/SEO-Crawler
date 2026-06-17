// One-off generator: download the official schema.org vocabulary and emit a
// trimmed schemaorg-vocab.json the SPA can load. Run with: npm run build-vocab
//
// Output shape:
// {
//   "version": "<schema.org release>",
//   "types": { "Article": { "subClassOf": ["CreativeWork", "Thing"] }, ... },
//   "properties": { "name": { "domains": ["Thing"], "ranges": ["Text"] }, ... }
// }
//
// "domains" lists the types a property is directly declared on (schema:domainIncludes).
// At validation time a property is valid on a type if the type or any of its
// ancestors appears in that property's domains.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'public', 'schemaorg-vocab.json');
const SOURCE = 'https://schema.org/version/latest/schemaorg-current-https.jsonld';

// schema.org terms are namespaced as "schema:Article" / "schema:name".
const isSchemaId = (id) => typeof id === 'string' && id.startsWith('schema:');
const term = (id) => (isSchemaId(id) ? id.slice('schema:'.length) : id);

// A JSON-LD value may be a single object, a single string, or an array of either.
function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}
// Collect referenced @ids, keeping only schema.org terms (drops external vocab links).
function ids(v) {
  return asArray(v)
    .map((x) => (typeof x === 'string' ? x : x && x['@id']))
    .filter(isSchemaId)
    .map(term);
}

// Normalize an rdfs:comment into a plain-text, single-paragraph description.
function comment(v) {
  if (v == null) return '';
  let s = typeof v === 'string' ? v : v['@value'] || '';
  s = s
    .replace(/\[\[([^\]]+)\]\]/g, '$1') // schema.org [[Term]] cross-refs -> Term
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // markdown links -> link text
    .replace(/<[^>]+>/g, '') // strip HTML tags
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\\n|\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Keep the first sentence or two; full comments can be long.
  if (s.length > 320) s = s.slice(0, 317).replace(/\s+\S*$/, '') + '…';
  return s;
}

async function main() {
  console.log(`Downloading ${SOURCE} ...`);
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const doc = await res.json();
  const graph = doc['@graph'] || [];

  const types = {};
  const properties = {};
  const version = 'latest';

  for (const node of graph) {
    if (!isSchemaId(node['@id'])) continue; // skip external-vocabulary nodes
    const t = asArray(node['@type']);
    const id = term(node['@id']);
    if (!id) continue;

    if (t.includes('rdfs:Class')) {
      types[id] = { subClassOf: ids(node['rdfs:subClassOf']), comment: comment(node['rdfs:comment']) };
    } else if (t.includes('rdf:Property')) {
      properties[id] = {
        domains: ids(node['schema:domainIncludes'] ?? node['domainIncludes']),
        ranges: ids(node['schema:rangeIncludes'] ?? node['rangeIncludes']),
        comment: comment(node['rdfs:comment']),
      };
    }
  }

  // Resolve full ancestor chains once so the client doesn't have to walk the
  // (possibly multiple-inheritance) graph repeatedly.
  const ancestorCache = {};
  function ancestors(typeName, seen = new Set()) {
    if (ancestorCache[typeName]) return ancestorCache[typeName];
    const out = new Set();
    for (const parent of types[typeName]?.subClassOf || []) {
      if (seen.has(parent)) continue;
      seen.add(parent);
      out.add(parent);
      for (const up of ancestors(parent, seen)) out.add(up);
    }
    const arr = [...out];
    ancestorCache[typeName] = arr;
    return arr;
  }
  for (const name of Object.keys(types)) {
    types[name].ancestors = ancestors(name);
  }

  const output = {
    version,
    generatedFrom: SOURCE,
    types,
    properties,
  };
  await writeFile(OUT, JSON.stringify(output));
  console.log(
    `Wrote ${OUT}: ${Object.keys(types).length} types, ${Object.keys(properties).length} properties (schema.org ${version}).`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
