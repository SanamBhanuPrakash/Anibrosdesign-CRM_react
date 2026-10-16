/**
 * Writes the OpenAPI document generated from the live route registry to docs/openapi.json.
 * No database connection is needed: the registry is populated by constructing the Express app.
 *
 *   npm run api:export   # docs/openapi.json
 *   npm run api:types    # + src/api/schema.d.ts (typed client contract)
 *   npm run api:check    # CI: fails when committed artefacts are stale
 */
import fs from 'node:fs';
import path from 'node:path';
process.env.NODE_ENV = process.env.NODE_ENV ?? 'development';

await import('../server/src/app'); // importing constructs the app, which registers every route
const { buildOpenApi } = await import('../server/src/platform/openapi');

const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
const doc = buildOpenApi({ version: pkg.version });
const out = path.resolve('docs/openapi.json');
const text = JSON.stringify(doc, null, 2) + '\n';

if (process.argv.includes('--check')) {
  // Line endings are not content: a Windows checkout with core.autocrlf turns the committed LF file into CRLF.
  const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\r\n').join('\n') : '';
  if (current !== text) {
    console.error('docs/openapi.json is stale. Run `npm run api:types` and commit the result.');
    process.exit(1);
  }
  console.log('openapi: up to date');
} else {
  fs.writeFileSync(out, text);
  console.log(`openapi: wrote ${path.relative(process.cwd(), out)} (${Object.keys(doc.paths).length} paths)`);
}
process.exit(0);
