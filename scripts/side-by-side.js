import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOMParser } from 'linkedom';
import { extract } from '../public/extract.js';
import { validate } from '../public/validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

globalThis.DOMParser = DOMParser;

async function runSideBySide() {
  const vocabPath = path.join(__dirname, '..', 'public', 'schemaorg-vocab.json');
  const vocab = JSON.parse(await readFile(vocabPath, 'utf8'));

  const fixtures = ['jsonld-good.html', 'jsonld-broken.html', 'jsonld-graph.html', 'microdata.html', 'rdfa.html'];

  console.log('========================================================================');
  console.log('                 SIDE-BY-SIDE VALIDATION REPORT                         ');
  console.log('========================================================================\n');

  for (const file of fixtures) {
    console.log(`\n--- Fixture: ${file} ---`);
    const html = await readFile(path.join(__dirname, '..', 'test', 'fixtures', file), 'utf8');
    const extracted = extract(html);
    
    if (extracted.all.length === 0) {
      console.log('  No structured data found.');
      continue;
    }

    extracted.all.forEach((item, index) => {
      const result = validate(item, vocab);
      const types = item.types.length ? item.types.join(', ') : 'Unknown';
      console.log(`\n  Item #${index + 1} | Format: ${item.format} | Type: ${types}`);
      
      console.log(`  Local Validator Results:`);
      console.log(`    Errors:   ${result.errors.length}`);
      result.errors.forEach(e => console.log(`      [❌] [${e.layer.toUpperCase()}] ${e.message}`));
      
      console.log(`    Warnings: ${result.warnings.length}`);
      result.warnings.forEach(w => console.log(`      [⚠️] [${w.layer.toUpperCase()}] ${w.message}`));
      
      console.log(`    Passes:   ${result.passes.length}`);
      result.passes.forEach(p => console.log(`      [✅] [${p.layer.toUpperCase()}] ${p.message}`));
      
      console.log('\n  Expected Google Rich Results / Schema.org Alignment:');
      if (result.errors.some(e => e.layer === 'structural')) {
        console.log(`      -> Google: "Unparsable structured data" (Fatal Error)`);
        console.log(`      -> Schema.org: "Invalid JSON-LD syntax"`);
      } else {
        const rrErrors = result.errors.filter(e => e.layer === 'rich-results');
        const vocabWarnings = result.warnings.filter(w => w.layer === 'vocabulary');
        
        if (rrErrors.length > 0) {
          console.log(`      -> Google: Not eligible for Rich Results (${rrErrors.map(e => e.prop || 'Missing required fields').join(', ')})`);
        } else {
          console.log(`      -> Google: Eligible for Rich Results (100% compliant)`);
        }

        if (vocabWarnings.length > 0) {
          console.log(`      -> Schema.org: Validation warnings on unknown/misplaced properties`);
        } else {
          console.log(`      -> Schema.org: 100% compliant with schema definitions`);
        }
      }
    });
  }
  console.log('\n========================================================================');
}

runSideBySide().catch(console.error);