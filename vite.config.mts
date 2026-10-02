import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
let commit = 'local'
try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim() } catch { /* source archive */ }

export default defineConfig({
  root: fileURLToPath(new URL('./demo', import.meta.url)),
  base: '/script-vm-next/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_COMMIT__: JSON.stringify(commit),
    'process.env': JSON.stringify({ NODE_ENV: 'production' }),
  },
  build: {
    outDir: '../demo-dist',
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./demo/index.html', import.meta.url)),
        runner: fileURLToPath(new URL('./demo/runner.html', import.meta.url)),
      },
    },
  },
  worker: { format: 'es' },
})
