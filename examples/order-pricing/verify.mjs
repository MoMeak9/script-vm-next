import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from 'script-vm-next';
import { priceOrder as nativePriceOrder } from './pricing.mjs';

const require = createRequire(import.meta.url);
const manifestPath = require.resolve('script-vm-next/package.json');
const manifest = require(manifestPath);
const cli = fileURLToPath(new URL(manifest.bin['script-vm-next'], pathToFileURL(manifestPath)));
const input = fileURLToPath(new URL('./pricing.mjs', import.meta.url));
const cliInput = fileURLToPath(new URL('./cli-entry.mjs', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'script-vm-order-pricing-'));
const cases = [
  [{ items: [], member: false }, { subtotal: 0, discount: 0, shipping: 0, total: 0 }],
  [{ items: [{ unitPriceCents: 2500, quantity: 2 }], member: true },
    { subtotal: 5000, discount: 500, shipping: 500, total: 5000 }],
  [{ items: [{ unitPriceCents: 5000, quantity: 2 }], member: false },
    { subtotal: 10000, discount: 0, shipping: 0, total: 10000 }],
  [{ items: [{ unitPriceCents: 5000, quantity: 2 }], member: true },
    { subtotal: 10000, discount: 1000, shipping: 500, total: 9500 }],
  [{ items: [{ unitPriceCents: 999, quantity: 1 }, { unitPriceCents: 2001, quantity: 2 }], member: true },
    { subtotal: 5001, discount: 500, shipping: 500, total: 5001 }],
];

function verify(priceOrder) {
  for (const [order, expected] of cases) {
    assert.deepEqual(nativePriceOrder(order), expected);
    assert.deepEqual(priceOrder(order), expected);
  }
  for (const item of [
    { unitPriceCents: -1, quantity: 1 },
    { unitPriceCents: 1, quantity: 0 },
    { unitPriceCents: 1.5, quantity: 1 },
    { unitPriceCents: Number.MAX_SAFE_INTEGER, quantity: 2 },
  ]) {
    const order = { items: [item], member: false };
    assert.throws(() => nativePriceOrder(order), { name: 'RangeError' });
    assert.throws(() => priceOrder(order), { name: 'RangeError' });
  }
}

try {
  for (const runtime of ['auto', 'full']) {
    const moduleOutput = join(temporary, `pricing-${runtime}.mjs`);
    compile(input, moduleOutput, { format: 'esm', runtime });
    const api = await import(pathToFileURL(moduleOutput).href);
    verify(api.priceOrder);
    console.log(`${runtime}/esm: 5 pricing cases and 4 rejection cases passed`);
    const output = join(temporary, `cli-${runtime}.mjs`);
    execFileSync(process.execPath, [cli, cliInput, '--output', output, '--format', 'esm', '--runtime', runtime], { timeout: 30_000 });
    const result = execFileSync(process.execPath, [output], { encoding: 'utf8', timeout: 10_000 });
    assert.deepEqual(JSON.parse(result), cases[1][1]);
    console.log(`${runtime}/CLI: bundled local module execution passed`);
  }
  console.log(`Verified installed script-vm-next@${manifest.version} on Node.js ${process.versions.node}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
