import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(import.meta.url)
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const versionSource = await readFile(resolve(root, 'src/version.ts'), 'utf8')
if (versionSource.match(/export const VERSION = ['"]([^'"]+)['"]/)?.[1] !== pkg.version) {
  throw new Error('src/version.ts must match package.json before building')
}
await rm(resolve(root, 'dist'), { recursive: true, force: true })
await mkdir(resolve(root, 'dist'), { recursive: true })
const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'], {
  cwd: root, stdio: 'inherit',
})
if (result.error) throw result.error
if (result.status !== 0) process.exit(result.status ?? 1)

// Node import and require share one implementation and one diagnostic class.
const api = require(resolve(root, 'dist/cjs/index.js'))
const names = Object.keys(api).filter(name => name !== '__esModule')
if (names.some(name => !/^[A-Za-z_$][\w$]*$/.test(name))) throw new Error('Invalid public export name')
await writeFile(resolve(root, 'dist/index.mjs'), [
  "import api from './cjs/index.js'",
  ...names.map(name => `export const ${name} = api.${name}`),
  'export default api', '',
].join('\n'))
await writeFile(resolve(root, 'dist/index.d.mts'), [
  "import * as api from './cjs/index.js'",
  "export * from './cjs/index.js'",
  'export default api', '',
].join('\n'))
await writeFile(resolve(root, 'dist/core.d.mts'), "export * from './cjs/core.js'\n")
await writeFile(resolve(root, 'dist/cli.js'), "#!/usr/bin/env node\nrequire('./cjs/cli.js')\n", { mode: 0o755 })

// The browser entry bundles Babel. It has no filesystem dependency or Node shim.
// Explicit environment constants make the artifact usable without `process`.
const browser = await build({
  absWorkingDir: root,
  entryPoints: ['src/core.ts'],
  outfile: 'dist/core.mjs',
  platform: 'browser',
  format: 'esm',
  target: 'es2020',
  bundle: true,
  minify: true,
  legalComments: 'eof',
  define: { 'process.env': JSON.stringify({ NODE_ENV: 'production' }) },
  metafile: true,
})
for (const output of Object.values(browser.metafile.outputs)) {
  if (output.imports.some(item => item.external && item.kind !== 'dynamic-import')) {
    throw new Error('Browser compiler contains an unresolved external import')
  }
}
console.log(`Built ${pkg.name}@${pkg.version}: Node CJS/ESM, browser core, CLI and declarations`)
