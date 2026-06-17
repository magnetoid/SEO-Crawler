// Validate a normalized item (from extract.js) in three layers:
//   1. structural  — JSON-LD well-formedness: @context, @type presence/shape
//   2. vocabulary  — types/properties exist in schema.org; props valid on type
//   3. rich results — Google required/recommended properties per feature
//
// Returns { errors[], warnings[], passes[], typeInfo[] }. Each finding is
//   { layer, message, prop?, detail?, docs? }
// where `detail` is a plain-language explanation of what's wrong and how to fix
// it, and `docs` is a relevant documentation link. `typeInfo` describes each
// declared type (name, whether schema.org knows it, and its description).

import { ruleFor } from './rich-results.js';
import { bareType } from './extract.js';

const SCHEMA_CONTEXT = /schema\.org/i;
const schemaDocs = (term: string) => `https://schema.org/${term}`;

export interface ValidationFinding {
  layer: 'structural' | 'vocabulary' | 'rich-results';
  message: string;
  prop?: string;
  detail?: string;
  docs?: string;
}

export interface ValidationResult {
  errors: ValidationFinding[];
  warnings: ValidationFinding[];
  passes: ValidationFinding[];
  typeInfo: Array<{ type: string; known: boolean; description: string; docs: string }>;
}

function mk(layer: ValidationFinding['layer'], message: string, extra: Partial<ValidationFinding> = {}): ValidationFinding {
  return { layer, message, ...extra };
}

// All ancestor type names for a type, including itself.
function typeChain(typeName: string, vocab: any): string[] {
  const t = vocab.types?.[typeName];
  if (!t) return [typeName];
  return [typeName, ...(t.ancestors || [])];
}

// Is `prop` valid on any of these types (or their ancestors)?
function propAllowedOnTypes(prop: string, types: string[], vocab: any) {
  const def = vocab.properties?.[prop];
  if (!def) return { known: false, allowed: false };
  if (!def.domains || def.domains.length === 0) return { known: true, allowed: true };
  const allTypes = new Set<string>();
  for (const t of types) for (const a of typeChain(t, vocab)) allTypes.add(a);
  const allowed = def.domains.some((d: string) => allTypes.has(d));
  return { known: true, allowed };
}

const propComment = (prop: string, vocab: any) => vocab?.properties?.[prop]?.comment || '';

// schema.org DataType leaves — when a value is a plain literal these ranges are
// satisfied, so we never flag text/number/date/url/boolean values.
const DATA_TYPES = new Set([
  'Text', 'URL', 'Number', 'Integer', 'Float', 'Boolean',
  'Date', 'DateTime', 'Time', 'DataType', 'CssSelectorType', 'XPathType', 'PronounceableText',
]);

// Pull the schema.org type names off an extracted property value. Returns [] for
// plain literals (strings/numbers/booleans) and for @id-only references.
function valueTypes(value: any): string[] {
  if (value == null) return [];
  if (typeof value !== 'object') return []; // literal (Text/URL/Number/…)
  const node = value.__item || (value.props ? value : null);
  return node && Array.isArray(node.types) ? node.types : [];
}

// Resolve the schema.org type(s) of a property value: a nested entity's own
// @type, or — for a collapsed {"@id": "..."} reference — the type of the node it
// points to (via the document's @id map), the way validator.schema.org does.
function resolveValueTypes(value: any, idMap: any): string[] {
  const direct = valueTypes(value);
  if (direct.length) return direct;
  if (typeof value === 'string' && idMap && idMap[value]) return idMap[value].map(bareType);
  return [];
}

// Mirror validator.schema.org: a value's resolved @type must be one of the
// property's rangeIncludes types (or a subtype). Returns the offending type
// name, or null if acceptable. Literals (unresolved strings/numbers) are fine.
function badTargetType(vts: string[], ranges: string[], vocab: any): string | null {
  if (!ranges || ranges.length === 0 || vts.length === 0) return null;
  for (const vt of vts) {
    if (!vocab.types[vt]) return null; // unknown value type — can't judge, stay quiet
    const chain = typeChain(vt, vocab);
    if (chain.some((t) => ranges.includes(t))) return null;
  }
  return vts[0];
}

// Property names that are framework/JSON-LD keywords or universally allowed.
const ALWAYS_OK = new Set(['additionalType', 'id', 'type']);

const MAX_DEPTH = 6;

export function validate(item: any, vocab: any): ValidationResult {
  const acc: ValidationResult = { errors: [], warnings: [], passes: [], typeInfo: [] };

  // --- Layer 1: structural (root only) --------------------------------------
  if (item.parseError) {
    acc.errors.push(
      mk('structural', item.parseError, {
        detail:
          'JSON-LD must be strictly valid JSON. Common causes: a trailing comma after the last ' +
          'property, single quotes instead of double quotes, unescaped quotes inside a string, ' +
          'or a comment. Paste the block into a JSON linter to pinpoint the character.',
      })
    );
    return acc;
  }

  if (item.format === 'jsonld') {
    if (item.context == null) {
      acc.warnings.push(
        mk('structural', 'Missing @context (expected "https://schema.org").', {
          detail:
            'Declare "@context": "https://schema.org" at the top of the block so search engines ' +
            'know which vocabulary the @type and properties come from. Without it the markup may be ignored.',
        })
      );
    } else {
      const ctxStr = JSON.stringify(item.context);
      if (SCHEMA_CONTEXT.test(ctxStr)) acc.passes.push(mk('structural', '@context references schema.org.'));
      else
        acc.warnings.push(
          mk('structural', '@context does not reference schema.org.', {
            detail:
              `Found @context = ${ctxStr}. Google reads schema.org vocabulary; set ` +
              '"@context": "https://schema.org" unless you are intentionally using another vocabulary.',
          })
        );
    }
  }

  const types = (item.types || []).map(bareType).filter(Boolean);
  if (types.length === 0) {
    acc.errors.push(
      mk('structural',
        item.format === 'jsonld'
          ? 'Missing @type — the entity has no schema.org type.'
          : 'No type declared (itemtype/typeof) — cannot validate against schema.org.', {
        detail:
          'Every structured-data entity needs a type so its meaning is defined — e.g. ' +
          (item.format === 'jsonld'
            ? '"@type": "Product".'
            : 'itemtype="https://schema.org/Product" (Microdata) or typeof="Product" (RDFa).'),
      })
    );
    return acc;
  }
  acc.passes.push(mk('structural', `Declared type: ${types.join(', ')}.`));

  // Validate the root node and every nested entity (Google/schema.org validate
  // the whole tree — e.g. the Offer inside a Product).
  validateNode({ types: item.types, props: item.props }, vocab, item.idMap, acc, '', 0);
  return acc;
}

// Layers 2 & 3 for one node, recursing into nested entities. Findings on nested
// nodes are prefixed with their property path (e.g. "offers → Offer: …").
function validateNode(node: any, vocab: any, idMap: any, acc: ValidationResult, path: string, depth: number) {
  const { errors, warnings, passes, typeInfo } = acc;
  const pfx = (m: string) => (path ? `${path}${m}` : m);
  const types = (node.types || []).map(bareType).filter(Boolean);
  const vocabReady = vocab && vocab.types && vocab.properties;

  if (types.length && vocabReady) {
    const knownTypes: string[] = [];
    for (const t of types) {
      const def = vocab.types[t];
      if (depth === 0) typeInfo.push({ type: t, known: !!def, description: def?.comment || '', docs: schemaDocs(t) });
      if (def) knownTypes.push(t);
      else
        warnings.push(mk('vocabulary', pfx(`Type "${t}" is not a known schema.org type.`), {
          prop: '@type', docs: schemaDocs(t),
          detail: `schema.org has no type named "${t}". Type names are PascalCase (e.g. "BlogPosting", ` +
            '"LocalBusiness"). Check the spelling and capitalization, or pick the closest existing type.',
        }));
    }
    if (knownTypes.length && depth === 0) passes.push(mk('vocabulary', `Recognized schema.org type(s): ${knownTypes.join(', ')}.`));

    if (knownTypes.length) {
      for (const prop of Object.keys(node.props || {})) {
        if (prop.startsWith('@') || ALWAYS_OK.has(prop)) continue;
        const { known, allowed } = propAllowedOnTypes(prop, knownTypes, vocab);
        if (!known) {
          warnings.push(mk('vocabulary', pfx(`Property "${prop}" is not a known schema.org property.`), {
            prop, docs: schemaDocs(knownTypes[0]),
            detail: `schema.org has no property "${prop}". Property names are camelCase (e.g. "datePublished"). ` +
              `Check for a typo, or see the list of valid properties for ${knownTypes.join('/')}.`,
          }));
        } else if (!allowed) {
          const def = vocab.properties[prop];
          warnings.push(mk('vocabulary', pfx(`Property "${prop}" is not expected on ${knownTypes.join('/')}.`), {
            prop, docs: schemaDocs(prop),
            detail: `schema.org defines "${prop}" on: ${def.domains.join(', ')}. It is likely ignored on ` +
              `${knownTypes.join('/')}. Move it to a nested entity of an appropriate type, or remove it.` +
              (def.comment ? ` "${prop}" means: ${def.comment}` : ''),
          }));
        }
        // Target-type (rangeIncludes) check — mirrors validator.schema.org.
        if (known) {
          const def = vocab.properties[prop];
          const values = Array.isArray(node.props[prop]) ? node.props[prop] : [node.props[prop]];
          const flagged = new Set();
          for (const value of values) {
            const bad = badTargetType(resolveValueTypes(value, idMap), def.ranges, vocab);
            if (bad && !flagged.has(bad)) {
              flagged.add(bad);
              errors.push(mk('vocabulary', pfx(`${bad} is not a known valid target type for the "${prop}" property.`), {
                prop, docs: schemaDocs(prop),
                detail: `schema.org expects the value of "${prop}" to be one of: ${def.ranges.join(', ')}. ` +
                  `A nested ${bad} entity is not a valid target type — use one of the expected types ` +
                  `(or a subtype of one), or a plain text/URL value where the property allows it.`,
              }));
            }
          }
        }
      }
    }

    // --- Layer 3: Google Rich Results ---
    for (const t of types) {
      const rule = ruleFor(t);
      if (!rule) continue;
      const present = new Set(Object.keys(node.props || {}).filter((k) => hasValue(node.props[k])));
      for (const req of rule.required || []) {
        if (present.has(req)) passes.push(mk('rich-results', pfx(`${rule.feature}: has required "${req}".`), { prop: req }));
        else errors.push(mk('rich-results', pfx(`${rule.feature}: missing required property "${req}".`), {
          prop: req, docs: rule.docs,
          detail: `Google requires "${req}" for ${rule.feature} rich results — without it this item is not ` +
            `eligible to appear as a ${rule.feature} rich result.` +
            (propComment(req, vocab) ? ` "${req}" means: ${propComment(req, vocab)}` : ''),
        }));
      }
      for (const group of rule.oneOf || []) {
        if (group.props.some((p: string) => present.has(p))) passes.push(mk('rich-results', pfx(`${rule.feature}: satisfies "${group.message}".`)));
        else errors.push(mk('rich-results', pfx(`${rule.feature}: requires ${group.message}.`), {
          docs: rule.docs,
          detail: `${rule.feature} rich results need ${group.message}. Add at least one of: ${group.props.join(', ')}.`,
        }));
      }
      for (const rec of rule.recommended || []) {
        if (present.has(rec)) passes.push(mk('rich-results', pfx(`${rule.feature}: has recommended "${rec}".`), { prop: rec }));
        else warnings.push(mk('rich-results', pfx(`${rule.feature}: missing recommended property "${rec}".`), {
          prop: rec, docs: rule.docs,
          detail: `"${rec}" is optional, but Google recommends it to enrich the ${rule.feature} rich result ` +
            `(more complete results can earn more prominent display).` +
            (propComment(rec, vocab) ? ` "${rec}" means: ${propComment(rec, vocab)}` : ''),
        }));
      }
      if (rule.note) warnings.push(mk('rich-results', pfx(`${rule.feature}: eligibility note.`), { docs: rule.docs, detail: rule.note }));
    }
  }

  // --- Recurse into inline nested entities ---
  if (depth < MAX_DEPTH) {
    for (const [prop, values] of Object.entries(node.props || {})) {
      const arr = Array.isArray(values) ? values : [values];
      for (const v of arr as any[]) {
        const child = v && typeof v === 'object' ? (v.__item || (v.props ? v : null)) : null;
        if (child && child.props) validateNode(child, vocab, idMap, acc, `${path}${prop} → `, depth + 1);
      }
    }
  }
}

function hasValue(values: any): boolean {
  if (!Array.isArray(values)) return values != null && values !== '';
  return values.some((v) => {
    if (v && v.__item) return true;
    return v != null && v !== '';
  });
}

// Validate every item and produce a per-item report plus rolled-up counts.
export function validateAll(items: any[], vocab: any) {
  const reports = items.map((item) => ({ item, result: validate(item, vocab) }));
  const totals = reports.reduce(
    (acc, r) => {
      acc.errors += r.result.errors.length;
      acc.warnings += r.result.warnings.length;
      acc.passes += r.result.passes.length;
      return acc;
    },
    { errors: 0, warnings: 0, passes: 0 }
  );
  return { reports, totals };
}
