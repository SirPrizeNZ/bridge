#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const stablePath = path.join(root, 'plugin', 'manifest.json');
const maxPath = path.join(root, 'plugin', 'manifest.max.json');

function usage(exitCode = 0) {
  const stream = exitCode ? process.stderr : process.stdout;
  stream.write(`Figma Agent Bridge manifest configurator\n\nUsage:\n  node scripts/configure-manifests.mjs <figma-plugin-id> [max-plugin-id]\n\nExamples:\n  npm run configure -- 1234567890123456789\n  npm run configure -- 1234567890123456789 9876543210987654321\n\nThe optional Max ID defaults to the stable ID so the two manifests can be used\nas alternate development manifests for the same local plugin.\n`);
  process.exit(exitCode);
}

const [, , stableId, maxIdArg] = process.argv;
if (!stableId || stableId === '--help' || stableId === '-h') usage(stableId ? 0 : 1);

function validateId(value, label) {
  if (typeof value !== 'string' || value.trim().length < 3 || value.length > 256) {
    throw new Error(`${label} must be a non-empty Figma-assigned plugin ID.`);
  }
  if (/\s/.test(value)) throw new Error(`${label} must not contain whitespace.`);
  return value.trim();
}

const stable = validateId(stableId, 'Stable plugin ID');
const maxId = validateId(maxIdArg || stable, 'Max plugin ID');

function patchManifest(file, id) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.id = id;
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

patchManifest(stablePath, stable);
patchManifest(maxPath, maxId);

process.stdout.write(`Configured manifests:\n  stable: ${stable}\n  max:    ${maxId}\n\nNext: import plugin/manifest.json in Figma Desktop.\n`);
