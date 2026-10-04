import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { transform } from '../index'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function fixture(sources: Record<string, string>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptvm-static-packages-'))
  directories.push(directory)
  for (const [name, source] of Object.entries(sources)) {
    const filename = path.join(directory, name)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.writeFileSync(filename, source)
  }
  return directory
}

function compare(directory: string, observe: (module: any) => unknown, options: Parameters<typeof transform>[1] = {}) {
  const entry = path.join(directory, 'entry.mjs')
  const output = path.join(directory, 'compiled.mjs')
  fs.writeFileSync(output, transform(entry, { ...options, format: 'esm' }))
  const run = (file: string) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', `
    const module = await import(${JSON.stringify(pathToFileURL(file).href)});
    process.stdout.write(JSON.stringify(await (${observe.toString()})(module)));
  `], { encoding: 'utf8', timeout: 10_000 }))
  const actual = run(output)
  expect(actual).toEqual(run(entry))
  return actual
}

const packageJSON = (fields: object) => JSON.stringify({ name: 'state', type: 'module', ...fields })

describe('static package ESM linking', () => {
  it('selects import/node conditions, preserves live bindings, defaults, namespaces and star re-exports', () => {
    const directory = fixture({
      'entry.mjs': `import start, { count, increment } from 'state'; import * as ns from 'state';
        export * from 'state'; export { start, ns }; export const initial = [start, count, ns.count];`,
      'node_modules/state/package.json': packageJSON({ exports: { '.': {
        browser: './wrong.mjs', node: { import: './index.js', require: './wrong.cjs' }, default: './wrong.mjs',
      } } }),
      'node_modules/state/index.js': 'export let count = 1; export function increment() { count++; } export default 8;',
      'node_modules/state/wrong.mjs': 'throw new Error("wrong import condition");',
      'node_modules/state/wrong.cjs': 'throw new Error("require branch must not be selected");',
    })
    expect(compare(directory, mod => {
      mod.increment()
      return [mod.initial, mod.count, mod.ns.count, mod.ns.default, mod.start, Object.keys(mod).sort()]
    })).toEqual([[8, 1, 1], 2, 2, 8, 8, ['count', 'increment', 'initial', 'ns', 'start']])
  })

  it('resolves package imports, self references, exports patterns and array fallbacks', () => {
    const directory = fixture({
      'entry.mjs': `export { answer, leaf, fallback } from 'state';`,
      'node_modules/state/package.json': packageJSON({
        imports: { '#private': { node: './private.mjs', default: './wrong.mjs' } },
        exports: { '.': './index.mjs', './feature/*': './features/*.mjs', './fallback': [null, './fallback.mjs'] },
      }),
      'node_modules/state/index.mjs': `import { value } from '#private'; import { leaf } from 'state/feature/leaf';
        export const answer = value + leaf; export { leaf }; export { fallback } from 'state/fallback';`,
      'node_modules/state/private.mjs': 'export const value = 40;',
      'node_modules/state/features/leaf.mjs': 'export const leaf = 2;',
      'node_modules/state/fallback.mjs': 'export const fallback = 3;',
    })
    expect(compare(directory, mod => [mod.answer, mod.leaf, mod.fallback])).toEqual([42, 2, 3])
  })

  it('keeps package cycles, TDZ, hoisted functions and dependency evaluation order', () => {
    const directory = fixture({
      'entry.mjs': `export * from 'state';`,
      'node_modules/state/package.json': packageJSON({ exports: './index.mjs' }),
      'node_modules/state/index.mjs': `import { early, error } from './other.mjs';
        export function read() { return 4; } export let value = 9; export { early, error };
        globalThis.moduleOrder.push('index'); export const order = globalThis.moduleOrder;`,
      'node_modules/state/other.mjs': `import { read, value } from 'state';
        globalThis.moduleOrder = ['other']; export const early = read(); export let error;
        try { value; } catch (e) { error = e.name; }`,
    })
    expect(compare(directory, mod => [mod.early, mod.error, mod.value, mod.order])).toEqual([4, 'ReferenceError', 9, ['other', 'index']])
  })

  it('resolves same-binding diamonds and omits conflicting package star exports', () => {
    const directory = fixture({
      'entry.mjs': `export * from 'state/left'; export * from 'state/right'; export { conflict as chosen } from 'state/left';`,
      'node_modules/state/package.json': packageJSON({ exports: { './*': './*.mjs' } }),
      'node_modules/state/shared.mjs': `export let value = 1; export function increment() { value++; } export default 'omitted';`,
      'node_modules/state/left.mjs': `export * from './shared.mjs'; export const conflict = 'left';`,
      'node_modules/state/right.mjs': `export * from './shared.mjs'; export const conflict = 'right';`,
    })
    expect(compare(directory, mod => {
      mod.increment()
      return [Object.keys(mod).sort(), mod.value, mod.chosen]
    })).toEqual([['chosen', 'increment', 'value'], 2, 'left'])
  })

  it('resolves symlinked package identity once and uses the dependency package scope', () => {
    const directory = fixture({
      'package.json': JSON.stringify({ type: 'commonjs' }),
      'entry.mjs': `import * as first from 'state'; import * as second from './packages/state/index.js';
        export const same = first === second; export const result = first.value;`,
      'packages/state/package.json': packageJSON({ exports: './index.js' }),
      'packages/state/index.js': `globalThis.evaluations = (globalThis.evaluations || 0) + 1; export const value = globalThis.evaluations;`,
    })
    fs.mkdirSync(path.join(directory, 'node_modules'))
    fs.symlinkSync(path.join(directory, 'packages/state'), path.join(directory, 'node_modules/state'), 'junction')
    expect(compare(directory, mod => [mod.same, mod.result])).toEqual([true, 1])
  })

  it('does not execute a dependency while resolving or compiling it', () => {
    const directory = fixture({
      'entry.mjs': `export * from 'state';`,
      'node_modules/state/package.json': packageJSON({ exports: './index.mjs' }),
      'node_modules/state/index.mjs': `throw new Error('dependency was executed'); export const value = 1;`,
    })
    expect(() => transform(path.join(directory, 'entry.mjs'), { format: 'esm' })).not.toThrow()
  })

  it('retains source-order native dependencies across a cycle before internal evaluation', () => {
    const directory = fixture({
      'entry.mjs': `import 'first'; import './other.mjs'; globalThis.order.push('entry'); export const order = globalThis.order;`,
      'other.mjs': `import './entry.mjs'; import 'second'; globalThis.order.push('other');`,
      'node_modules/first/package.json': JSON.stringify({ main: './index.cjs' }),
      'node_modules/first/index.cjs': `globalThis.order = ['first'];`,
      'node_modules/second/package.json': JSON.stringify({ main: './index.cjs' }),
      'node_modules/second/index.cjs': `globalThis.order.push('second');`,
    })
    expect(compare(directory, mod => mod.order)).toEqual(['first', 'second', 'other', 'entry'])
  })

  it.each([false, true])('rejects host interleaving that would change source side-effect order (explicit ESM: %s)', externalESM => {
    const directory = fixture({
      'entry.mjs': `import './local.mjs'; import 'state'; globalThis.order.push('entry'); export const order = globalThis.order;`,
      'local.mjs': `globalThis.order = ['local'];`,
      'node_modules/state/package.json': packageJSON({ type: externalESM ? 'module' : 'commonjs', exports: './index.js' }),
      'node_modules/state/index.js': `globalThis.order.push('host');`,
    })
    const entry = path.join(directory, 'entry.mjs')
    expect(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '--eval', `
      const module = await import(${JSON.stringify(pathToFileURL(entry).href)}); process.stdout.write(JSON.stringify(module.order));
    `], { encoding: 'utf8', timeout: 10_000 }))).toEqual(['local', 'host', 'entry'])
    expect(() => transform(entry, { format: 'esm', external: externalESM ? ['state'] : [] }))
      .toThrow(/Cannot preserve module evaluation order.*state.*local.mjs/)
    if (externalESM) expect(compare(directory, mod => mod.order)).toEqual(['local', 'host', 'entry'])
  })

  it('allows repeated host imports and builtin imports after an internal module', () => {
    const directory = fixture({
      'entry.mjs': `import 'state'; import './local.mjs'; import * as state from 'state'; import { basename } from 'node:path';
        export const result = [globalThis.order, state.default, basename('/a/b')];`,
      'local.mjs': `globalThis.order.push('local');`,
      'node_modules/state/package.json': packageJSON({ type: 'commonjs', exports: './index.cjs' }),
      'node_modules/state/index.cjs': `globalThis.order = ['host']; module.exports = 9;`,
    })
    expect(compare(directory, mod => mod.result)).toEqual([['host', 'local'], 9, 'b'])
  })

  it('retains Node native CommonJS default, named snapshot and namespace interoperability', () => {
    const directory = fixture({
      'entry.mjs': `import value, { count, change } from 'state'; import * as ns from 'state';
        import { basename } from 'node:path';
        export const initial = [value.count, count, ns.count, ns.default === value, basename('/a/b')];
        export function update() { change(); return [value.count, count, ns.count]; }`,
      'node_modules/state/package.json': packageJSON({ type: 'commonjs', exports: { import: './index.cjs', require: './wrong.cjs' } }),
      'node_modules/state/index.cjs': 'exports.count = 1; exports.change = function() { exports.count++; };',
      'node_modules/state/wrong.cjs': 'throw new Error("wrong require condition");',
    })
    expect(compare(directory, mod => [mod.initial, mod.update()])).toEqual([[1, 1, 1, true, 'b'], [2, 1, 1]])
  })

  it('supports named and default re-exports of explicitly external ESM namespaces', () => {
    const directory = fixture({
      'entry.mjs': `export * from './bridge.mjs'; export { default } from './bridge.mjs';`,
      'bridge.mjs': `export { default, count, increment } from 'state'; export * as state from 'state';`,
      'node_modules/state/package.json': packageJSON({ exports: './index.mjs' }),
      'node_modules/state/index.mjs': `export let count = 1; export function increment() { count++; } export default 8;`,
    })
    expect(compare(directory, mod => {
      mod.increment()
      return [mod.default, mod.count, mod.state.count]
    }, { external: ['state'] })).toEqual([8, 2, 2])
  })

  it('does not fall back to host execution for untyped .js ESM sources', () => {
    const directory = fixture({
      'entry.mjs': `export { value } from './dependency.js';`,
      'dependency.js': `export const value = 42;`,
    })
    const code = transform(path.join(directory, 'entry.mjs'), { format: 'esm' })
    fs.rmSync(path.join(directory, 'dependency.js'))
    const output = path.join(directory, 'compiled.mjs')
    fs.writeFileSync(output, code)
    expect(execFileSync(process.execPath, ['--input-type=module', '--eval', `
      import { value } from ${JSON.stringify(pathToFileURL(output).href)}; process.stdout.write(String(value));
    `], { encoding: 'utf8', timeout: 10_000 })).toBe('42')
  })

  it('retains the file API local extension and directory-index conveniences', () => {
    const directory = fixture({
      'entry.mjs': `export { first } from './first'; export { second } from './folder';`,
      'first.mjs': `export const first = 20;`,
      'folder/index.mjs': `export const second = 22;`,
    })
    const code = transform(path.join(directory, 'entry.mjs'), { format: 'esm' })
    const output = path.join(directory, 'compiled.mjs')
    fs.writeFileSync(output, code)
    expect(execFileSync(process.execPath, ['--input-type=module', '--eval', `
      import { first, second } from ${JSON.stringify(pathToFileURL(output).href)}; process.stdout.write(String(first + second));
    `], { encoding: 'utf8', timeout: 10_000 })).toBe('42')
  })

  it('produces self-contained ESM after source packages are removed and output is relocated', () => {
    const directory = fixture({
      'entry.mjs': `export * from 'state';`,
      'node_modules/state/package.json': packageJSON({ exports: './index.mjs' }),
      'node_modules/state/index.mjs': `export const value = 42;`,
    })
    const code = transform(path.join(directory, 'entry.mjs'), { format: 'esm' })
    fs.rmSync(path.join(directory, 'node_modules'), { recursive: true })
    fs.rmSync(path.join(directory, 'entry.mjs'))
    const destination = fixture({ 'compiled.mjs': code })
    const output = path.join(destination, 'compiled.mjs')
    expect(execFileSync(process.execPath, ['--input-type=module', '--eval', `
      import { value } from ${JSON.stringify(pathToFileURL(output).href)}; process.stdout.write(String(value));
    `], { encoding: 'utf8', timeout: 10_000 })).toBe('42')
  })

  it('retains native missing-export validation for host external namespaces', () => {
    const directory = fixture({
      'entry.mjs': `import { missing } from 'state'; export const read = () => missing;`,
      'node_modules/state/package.json': packageJSON({ exports: './index.mjs' }),
      'node_modules/state/index.mjs': `export const value = 42;`,
    })
    const output = path.join(directory, 'compiled.mjs')
    fs.writeFileSync(output, transform(path.join(directory, 'entry.mjs'), { format: 'esm', external: ['state'] }))
    const result = execFileSync(process.execPath, ['--input-type=module', '--eval', `
      try { await import(${JSON.stringify(pathToFileURL(output).href)}); }
      catch (error) { process.stdout.write(error.name + ':' + error.message); }
    `], { encoding: 'utf8', timeout: 10_000 })
    expect(result).toMatch(/^SyntaxError:.*does not provide an export named 'missing'/)
  })

  it('rejects inaccessible exports and missing/ambiguous bindings before evaluation', () => {
    const directory = fixture({
      'entry.mjs': `import { missing } from 'state'; export { missing };`,
      'node_modules/state/package.json': packageJSON({ exports: './index.mjs' }),
      'node_modules/state/index.mjs': `throw new Error('never execute'); export const value = 1;`,
    })
    expect(() => transform(path.join(directory, 'entry.mjs'), { format: 'esm' })).toThrow('no unambiguous export')
    fs.writeFileSync(path.join(directory, 'entry.mjs'), `export * from 'state/private.mjs';`)
    expect(() => transform(path.join(directory, 'entry.mjs'), { format: 'esm' })).toThrow('ERR_PACKAGE_PATH_NOT_EXPORTED')
  })

  it.each([
    ['.json', '{}'], ['.node', ''], ['.wasm', ''],
  ])('diagnoses unsupported %s loaders without evaluating dependencies', (extension, contents) => {
    const directory = fixture({
      'entry.mjs': `import value from 'state'; export { value };`,
      'node_modules/state/package.json': packageJSON({ exports: `./index${extension}` }),
      [`node_modules/state/index${extension}`]: contents,
    })
    expect(() => transform(path.join(directory, 'entry.mjs'), { format: 'esm' })).toThrow('requires a loader')
  })

  it.each(['data:text/javascript,export default 1', './other.mjs?instance=1'])('diagnoses unsupported module identities: %s', specifier => {
    const directory = fixture({
      'entry.mjs': `import value from ${JSON.stringify(specifier)}; export { value };`,
      'other.mjs': 'export default 1;',
    })
    expect(() => transform(path.join(directory, 'entry.mjs'), { format: 'esm' })).toThrow(/Unsupported static module/)
  })
})
