// Regenerates devices.json from the shared catalog snapshot, keeping only what the scene needs.
//   node gen-devices.mjs [path/to/shared_catalog_snapshot.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2] ?? path.join(here, '../../../../scripts/experiments/output/shared_catalog_snapshot.json');
const snap = JSON.parse(fs.readFileSync(src, 'utf8'));
const devices = snap.resources.map(r => ({ id: r.resource_id, name: r.name, vendor: r.vendor, provider: r.provider_id, qubits: r.num_qubits }));
fs.writeFileSync(path.join(here, 'devices.json'), JSON.stringify({ captured_at: snap.captured_at, devices }, null, 2) + '\n');
console.log(`wrote ${devices.length} devices`);
