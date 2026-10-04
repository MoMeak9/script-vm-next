import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const vitest = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
for (const runtime of ['auto', 'full']) {
  console.log(`\nRunning the complete unit suite with ${runtime} runtime assembly.`)
  const result = spawnSync(process.execPath, [vitest, 'run', ...process.argv.slice(2)], {
    stdio: 'inherit', env: { ...process.env, SCRIPT_VM_TEST_RUNTIME: runtime },
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
