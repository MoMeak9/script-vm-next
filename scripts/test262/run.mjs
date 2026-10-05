import { createHash } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readMetadata, variants } from './metadata.mjs'
import { runJobs } from './pool.mjs'

export function loadCorpus(root) {
  const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
  const paths = new Set()
  for (const file of manifest.files) {
    const absolute = resolve(root, file.path)
    if (!absolute.startsWith(`${resolve(root)}${sep}`) || paths.has(file.path)) throw new Error(`Invalid or duplicate fixture path: ${file.path}`)
    paths.add(file.path)
    const hash = createHash('sha256').update(readFileSync(absolute)).digest('hex')
    if (hash !== file.sha256) throw new Error(`Fixture integrity mismatch: ${file.path}`)
  }
  for (const required of ['LICENSE', 'harness/sta.js', 'harness/assert.js']) {
    if (!paths.has(required)) throw new Error(`Unpinned harness/license: ${required}`)
  }
  const jobs = []
  for (const file of manifest.files.filter(file => file.path.startsWith('test/'))) {
    const metadata = readMetadata(readFileSync(resolve(root, file.path), 'utf8'))
    for (const include of metadata.includes) {
      if (!/^[\w.-]+\.js$/.test(include) || !paths.has(`harness/${include}`)) throw new Error(`Unpinned or invalid harness include: ${include}`)
    }
    for (const variant of variants(metadata)) jobs.push({ root, path: file.path, metadata, ...variant })
  }
  if (!jobs.length) throw new Error('The selected Test262 corpus is empty')
  return { manifest, jobs }
}

export function summarize(results) {
  return {
    files: new Set(results.map(result => result.path)).size,
    variants: results.length,
    passed: results.filter(result => result.status === 'pass').length,
    failed: results.filter(result => result.status === 'fail').length,
    skipped: results.filter(result => result.status === 'skip').length,
    timedOut: results.filter(result => result.timeout).length,
  }
}

export function runtimeModes(args = []) {
  if (!args.length || args.length === 1 && args[0] === '--runtime=both') return ['auto', 'full']
  if (args.length === 1 && /^--runtime=(auto|full)$/.test(args[0])) return [args[0].split('=')[1]]
  throw new Error('Usage: node scripts/test262/run.mjs [--runtime=auto|full|both]')
}

async function main() {
  const root = fileURLToPath(new URL('../../vendor/test262/', import.meta.url))
  const { manifest, jobs } = loadCorpus(root)
  const runtimes = runtimeModes(process.argv.slice(2))
  const results = await runJobs(runtimes.flatMap(runtime => jobs.map(job => ({ ...job, runtime }))))
  const summary = summarize(results)
  const runtimeSummaries = Object.fromEntries(runtimes.map(runtime => [runtime, summarize(results.filter(result => result.runtime === runtime))]))
  const report = { upstream: manifest.upstream, revision: manifest.revision, summary, runtimeSummaries, results: results.map(({ root: _root, ...result }) => result) }
  const reportPath = fileURLToPath(new URL('../../artifacts/test262/report.json', import.meta.url))
  mkdirSync(dirname(reportPath), { recursive: true })
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  for (const result of results.filter(result => result.status !== 'pass')) {
    console.log(`${result.status.toUpperCase()} ${result.path} [${result.mode}/${result.runtime}] ${result.engine ?? ''}: ${result.detail}`)
  }
  for (const [runtime, counts] of Object.entries(runtimeSummaries)) {
    console.log(`Test262 ${manifest.revision} [${runtime}]: ${counts.files} files, ${counts.variants} variants; ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.timedOut} timed out.`)
  }
  console.log(`Report: ${reportPath}`)
  // The committed baseline has no allowed failures or skips.
  if (summary.failed || summary.skipped) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1 })
}
