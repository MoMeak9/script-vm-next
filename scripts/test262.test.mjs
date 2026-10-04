import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readMetadata, variants } from './test262/metadata.mjs'
import { executeVariant } from './test262/execute.mjs'
import { runJobs } from './test262/pool.mjs'
import { loadCorpus, summarize } from './test262/run.mjs'

const metadata = (body = '') => readMetadata(`/*---\n${body}\n---*/\n`)
const compile = source => {
  try { new vm.Script(source) } catch (cause) {
    throw Object.assign(new Error(cause.message), { code: 'SYNTAX_ERROR', stage: 'parse', cause })
  }
  return { code: source }
}
const run = overrides => executeVariant({
  source: 'if (2 + 2 !== 4) throw new Error("assertion failed")', filename: 'fixture.js',
  metadata: metadata(), mode: 'sloppy', harness: [], compile, ...overrides,
})

test('reads execution YAML without interpreting descriptive block text as metadata', () => {
  const result = metadata(`description: >\n  flags: [async]\nflags: [onlyStrict, generated] # comment\nincludes:\n  - compareArray.js\nfeatures:\n  - 'arrow-function'\nnegative:\n  phase: runtime\n  type: TypeError`)
  assert.deepEqual(result, { flags: ['onlyStrict', 'generated'], includes: ['compareArray.js'], features: ['arrow-function'], negative: { phase: 'runtime', type: 'TypeError' } })
})

test('rejects missing, duplicated, conflicting, and malformed execution metadata', () => {
  for (const body of ['flags: [onlyStrict, noStrict]', 'flags: [raw, onlyStrict]', 'flags: [raw]\nincludes: [assert.js]', 'flags: []\nflags: []', 'includes: *alias', 'negative:\n  phase: runtime', 'negative:\n  phase: invalid\n  type: TypeError']) {
    assert.throws(() => metadata(body))
  }
  assert.throws(() => readMetadata('var x = 1;'), /frontmatter/)
})

test('schedules strict and sloppy variants, respecting onlyStrict/noStrict/raw', () => {
  assert.deepEqual(variants(metadata()), [{ mode: 'sloppy' }, { mode: 'strict' }])
  assert.deepEqual(variants(metadata('flags: [onlyStrict]')), [{ mode: 'strict' }])
  assert.deepEqual(variants(metadata('flags: [noStrict]')), [{ mode: 'sloppy' }])
  assert.deepEqual(variants(metadata('flags: [raw]')), [{ mode: 'raw' }])
  for (const flag of ['async', 'module', 'future-unknown-flag', 'CanBlockIsTrue']) assert.match(variants(metadata(`flags: [${flag}]`))[0].skip, /Unsupported/)
  assert.match(variants(metadata('negative:\n  phase: resolution\n  type: SyntaxError'))[0].skip, /resolution/)
})

test('runs both native assertions and the emitted program', () => {
  assert.equal(run().status, 'pass')
  const result = run({ compile: () => ({ code: 'throw new Error("VM mismatch")' }) })
  assert.equal(result.status, 'fail')
  assert.equal(result.engine, 'vm')
  assert.match(result.detail, /VM mismatch/)
  assert.equal(run({ source: 'throw new Error("bad oracle")' }).engine, 'native')
})

test('strict transformation applies to the actual compiled input', () => {
  let seen
  assert.equal(run({ mode: 'strict', compile: source => { seen = source; return compile(source) } }).status, 'pass')
  assert.match(seen, /^"use strict";/)
})

test('parse negatives require parse-phase SyntaxError, not arbitrary compiler rejection', () => {
  const fixture = { source: 'let = ;', metadata: metadata('negative:\n  phase: parse\n  type: SyntaxError') }
  assert.equal(run(fixture).status, 'pass')
  for (const fail of [() => { throw Object.assign(new Error('unsupported'), { stage: 'lower', code: 'COMPILATION_ERROR' }) }, () => ({ code: '' })]) {
    const result = run({ ...fixture, compile: fail })
    assert.equal(result.status, 'fail')
    assert.equal(result.engine, 'vm')
  }
})

test('runtime negatives require the exact exception constructor from the test realm', () => {
  const fixture = { source: 'throw new TypeError("expected")', metadata: metadata('negative:\n  phase: runtime\n  type: TypeError') }
  assert.equal(run(fixture).status, 'pass')
  for (const code of ['', 'throw new RangeError()', 'throw { name: "TypeError" }', 'throw new (class extends TypeError {})()', 'TypeError = Error; throw new Error()']) {
    const result = run({ ...fixture, compile: () => ({ code }) })
    assert.equal(result.status, 'fail')
    assert.equal(result.engine, 'vm')
  }
  assert.match(run({ ...fixture, compile: () => { throw new SyntaxError('bad compile') } }).detail, /compile failure/)
})

test('invalid emitted JavaScript cannot satisfy runtime-negative SyntaxError expectations', () => {
  const result = run({ source: 'throw new SyntaxError()', metadata: metadata('negative:\n  phase: runtime\n  type: SyntaxError'), compile: () => ({ code: 'let = ;' }) })
  assert.equal(result.status, 'fail')
  assert.equal(result.engine, 'vm')
  assert.match(result.detail, /Invalid emitted JavaScript/)
})

test('harness failures cannot satisfy runtime-negative expectations', () => {
  const result = run({ source: '', metadata: metadata('negative:\n  phase: runtime\n  type: TypeError'), harness: [{ filename: 'broken.js', source: 'throw new TypeError()' }] })
  assert.match(result.detail, /Harness failed/)
})

test('uses fresh realms so global mutations do not leak between variants', () => {
  assert.equal(run({ source: 'Array.prototype.leaked = 1' }).status, 'pass')
  assert.equal(run({ source: 'if (Array.prototype.leaked) throw new Error("leaked")' }).status, 'pass')
})

test('an execution timeout fails even if a runtime Error is expected', () => {
  const result = run({ source: 'while (true) {}', timeoutMs: 10, metadata: metadata('negative:\n  phase: runtime\n  type: Error') })
  assert.equal(result.status, 'fail')
  assert.equal(result.timeout, true)
})

test('worker timeout and unexpected exit fail explicitly and do not prevent later cases', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'script-vm-test262-worker-'))
  const filename = join(directory, 'worker.mjs')
  writeFileSync(filename, `import { parentPort } from 'node:worker_threads'; parentPort.on('message', job => { if (job.hang) while (true) {} if (job.exit) process.exit(12); parentPort.postMessage({ status: 'pass' }); });`)
  try {
    const results = await runJobs([{ hang: true }, { exit: true }, {}, {}], { workers: 1, timeoutMs: 500, workerFile: pathToFileURL(filename) })
    assert.deepEqual(results.map(result => result.status), ['fail', 'fail', 'pass', 'pass'])
    assert.equal(results[0].timeout, true)
    assert.equal(results[1].workerError, true)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('integrity verification fails closed for tampering, unpinned includes, and path traversal', () => {
  const root = mkdtempSync(join(tmpdir(), 'script-vm-test262-integrity-'))
  const writeManifest = entries => writeFileSync(join(root, 'manifest.json'), JSON.stringify({ files: entries }))
  const files = ['LICENSE', 'harness/sta.js', 'harness/assert.js', 'test/fixture.js'].map(path => {
    const absolute = join(root, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, path.startsWith('test/') ? '/*---\nflags: [noStrict]\n---*/\n' : '')
    return { path, sha256: createHash('sha256').update(readFileSync(absolute)).digest('hex') }
  })
  try {
    writeManifest(files)
    assert.equal(loadCorpus(root).jobs.length, 1)
    writeFileSync(join(root, 'test/fixture.js'), 'tampered')
    assert.throws(() => loadCorpus(root), /integrity/)
    writeManifest([{ path: '../outside.js', sha256: '' }])
    assert.throws(() => loadCorpus(root), /Invalid/)
    writeManifest(files.filter(file => !file.path.startsWith('test/')))
    assert.throws(() => loadCorpus(root), /empty/)
    const contents = '/*---\nincludes: [untracked.js]\n---*/\n'
    writeFileSync(join(root, 'test/fixture.js'), contents)
    files.at(-1).sha256 = createHash('sha256').update(contents).digest('hex')
    writeManifest(files)
    assert.throws(() => loadCorpus(root), /Unpinned/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('reports failures, skips, and timeouts honestly as separate counts', () => {
  assert.deepEqual(summarize([{ path: 'one', status: 'pass' }, { path: 'one', status: 'fail', timeout: true }, { path: 'two', status: 'skip' }]), { files: 2, variants: 3, passed: 1, failed: 1, skipped: 1, timedOut: 1 })
})
