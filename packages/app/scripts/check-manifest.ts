/**
 * `bun run manifest:check` — fail if manifests/slack-app.manifest.json drifts from the wiring.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkManifest, wiredEventsFromSource } from '../src/manifest-check.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const manifest: unknown = JSON.parse(
  readFileSync(`${root}manifests/slack-app.manifest.json`, 'utf8'),
);
const wiring = readFileSync(`${root}packages/app/src/wiring.ts`, 'utf8');
const errors = checkManifest(manifest, { wiredEvents: wiredEventsFromSource(wiring) });
if (errors.length) {
  console.error(`Slack manifest check failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  process.exit(1);
}
console.log('Slack manifest matches the wiring.');
