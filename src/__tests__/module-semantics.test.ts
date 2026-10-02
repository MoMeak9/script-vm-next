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

async function compareModules(
  sources: Record<string, string>,
  observe: (module: any) => unknown | Promise<unknown>,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptvm-module-semantics-'))
  directories.push(dir)
  for (const [name, source] of Object.entries(sources)) {
    fs.writeFileSync(path.join(dir, name), source)
  }
  const output = path.join(dir, 'compiled.mjs')
  fs.writeFileSync(output, transform(path.join(dir, 'entry.mjs'), { format: 'esm', bundle: true }))
  // Run both sides under Node's native ESM loader. Vitest rewrites ESM imports,
  // including default declarations and export-star ambiguity, so is not an oracle.
  const run = (file: string) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    const module = await import(${JSON.stringify(pathToFileURL(file).href)});
    const value = await (${observe.toString()})(module);
    process.stdout.write(JSON.stringify(value));
  `], { encoding: 'utf8', timeout: 10_000 }))
  const expected = run(path.join(dir, 'entry.mjs'))
  const actual = run(output)
  expect(actual).toEqual(expected)
  return actual
}

describe('ESM live bindings compared with native modules', () => {
  it('updates public aliases and retains assignment and update expression results', async () => {
    expect(await compareModules({ 'entry.mjs': `
      export let count = 1;
      export { count as alias, count as default, count as 'with-dash' };
      export function update() {
        const old = count++;
        const next = ++count;
        const assigned = (count = 8);
        return [old, next, assigned];
      }
    ` }, async mod => {
      const before = [mod.count, mod.alias, mod.default, mod['with-dash']]
      const result = mod.update()
      return [before, result, mod.count, mod.alias, mod.default, mod['with-dash']]
    })).toEqual([[1, 1, 1, 1], [1, 3, 8], 8, 8, 8, 8])
  })

  it('keeps internal named imports live, including re-export chains and namespaces', async () => {
    expect(await compareModules({
      'counter.mjs': 'export let count = 1; export function increment() { count++; }',
      'middle.mjs': "export { count as value, increment } from './counter.mjs'; export * as counter from './counter.mjs';",
      'entry.mjs': `
        import { value, increment, counter } from './middle.mjs';
        export { value as count, increment };
        export function read() { return [value, counter.count]; }
        export function shadow(value) { return value; }
      `,
    }, mod => {
      const before = mod.read()
      mod.increment()
      return [before, mod.read(), mod.count, mod.shadow(20)]
    })).toEqual([[1, 1], [2, 2], 2, 20])
  })

  it('treats default expressions as snapshots and named default declarations as live', async () => {
    expect(await compareModules({
      'snapshot.mjs': 'let count = 1; export default count; export function increment() { count++; }',
      'entry.mjs': `
        import snapshot, { increment } from './snapshot.mjs';
        export default function value() { return 1; }
        export function replace() { value = function () { return 2; }; increment(); }
        export function readSnapshot() { return snapshot; }
      `,
    }, mod => {
      const before = mod.default()
      mod.replace()
      return [before, mod.default(), mod.readSnapshot()]
    })).toEqual([1, 2, 1])
  })

  it('propagates async and escaped closure writes', async () => {
    expect(await compareModules({ 'entry.mjs': `
      export let count = 1;
      export async function increment() { await Promise.resolve(); count += 2; }
      export function makeSetter() { return function (value) { count = value; }; }
    ` }, async mod => {
      await mod.increment()
      const afterAsync = mod.count
      mod.makeSetter()(12)
      return [afterAsync, mod.count]
    })).toEqual([3, 12])
  })

  it('updates star exports, omits defaults and ambiguous names, and honors explicit exports', async () => {
    expect(await compareModules({
      'one.mjs': 'export let count = 1; export const conflict = 1; export default 10; export function increment() { count++; }',
      'two.mjs': 'export const conflict = 2; export const chosen = 8;',
      'entry.mjs': `export * from './one.mjs'; export * from './two.mjs'; export { conflict as chosen } from './one.mjs';`,
    }, mod => {
      mod.increment()
      return [Object.keys(mod).sort(), mod.count, mod.chosen]
    })).toEqual([['chosen', 'count', 'increment'], 2, 1])
  })

  it('preserves same-binding star exports through a diamond', async () => {
    await compareModules({
      'value.mjs': 'export let value = 1; export function increment() { value++; }',
      'left.mjs': "export * from './value.mjs';",
      'right.mjs': "export * from './value.mjs';",
      'entry.mjs': "export * from './left.mjs'; export * from './right.mjs';",
    }, mod => { mod.increment(); return [Object.keys(mod).sort(), mod.value] })
  })

  it('avoids user identifiers and preserves host global reads and writes', async () => {
    await compareModules({ 'entry.mjs': `
      export let __scriptvmNotifyExports = 1;
      const __exports = 3; const __m = 4; const Object = 5;
      export function update() { __scriptvmNotifyExports++; return [__exports, __m, Object]; }
      export function globalRead() { globalThis.__moduleSemanticProbe = 9; __moduleSemanticProbe = 10; return [__moduleSemanticProbe, globalThis.__moduleSemanticProbe]; }
    ` }, mod => {
      const result = [mod.update(), mod.__scriptvmNotifyExports, mod.globalRead(), Object.prototype.hasOwnProperty.call(globalThis, '__scriptvmNotifyExports_')]
      delete (globalThis as any).__moduleSemanticProbe
      return result
    })
  })

  it('avoids nested registry, namespace and notification parameter collisions', async () => {
    expect(await compareModules({
      'value.mjs': 'export const value = 3;',
      'entry.mjs': `
        import { value } from './value.mjs';
        export let count = 1;
        export function read(__m, __exports) { return value; }
        export function increment(__scriptvmNotifyExports) { count++; }
        export const result = read({}, {});
      `,
    }, mod => { mod.increment(null); return [mod.result, mod.read({}, {}), mod.count] })).toEqual([3, 3, 2])
  })

  it('preserves user declaration names that coincide with bundler internals and intrinsics', async () => {
    expect(await compareModules({ 'entry.mjs': `
      export function Object() {}
      export class Proxy {}
      export class TypeError {}
      export function __m() {}
      export function __exports() {}
      export const names = [Object.name, Proxy.name, TypeError.name, __m.name, __exports.name];
    ` }, mod => [mod.names, Object.keys(mod).sort()])).toEqual([
      ['Object', 'Proxy', 'TypeError', '__m', '__exports'],
      ['Object', 'Proxy', 'TypeError', '__exports', '__m', 'names'],
    ])
  })

  it('retains explicit names and their descriptors for all closure kinds', async () => {
    await compareModules({ 'entry.mjs': `
      export function regular() {}
      export async function asynchronous() {}
      export function* generator() {}
      export async function* asyncGenerator() {}
    ` }, mod => ['regular', 'asynchronous', 'generator', 'asyncGenerator']
      .map(name => Object.getOwnPropertyDescriptor(mod[name], 'name')))
  })

  it('exports function declarations without leaking their parameters', async () => {
    expect(await compareModules({ 'entry.mjs': `
      export function add(left, right) { return left + right; }
    ` }, mod => [Object.keys(mod), mod.add(2, 3)])).toEqual([['add'], 5])
  })

  it('publishes loop assignments before the loop body executes', async () => {
    expect(await compareModules({ 'entry.mjs': `
      export let value = 0;
      export function loop(observe) {
        const seen = [];
        for (value of [2, 3]) seen.push(observe());
        for (value in { a: 1, b: 2 }) seen.push(observe());
        return seen;
      }
    ` }, mod => [mod.loop(() => mod.value), mod.value])).toEqual([[2, 3, 'a', 'b'], 'b'])
  })

  it('preserves exported destructuring declarations', async () => {
    await compareModules({ 'entry.mjs': `
      export let { first: value, second } = { first: 2, second: 3 };
      export function update() { value += second; }
    ` }, mod => { mod.update(); return [mod.value, mod.second] })
  })

  it('keeps escaped module namespaces read-only', async () => {
    expect(await compareModules({
      'counter.mjs': 'export let count = 1; export function increment() { count++; }',
      'entry.mjs': `
        import * as counter from './counter.mjs';
        function modify(namespace) {
          const errors = [];
          try { namespace.count = 5; } catch (error) { errors.push(error.name); }
          try { namespace.extra = 7; } catch (error) { errors.push(error.name); }
          try { delete namespace.count; } catch (error) { errors.push(error.name); }
          return [errors, namespace.count, Object.keys(namespace).sort(), delete namespace.absent];
        }
        export function check() { return modify(counter); }
      `,
    }, mod => mod.check())).toEqual([['TypeError', 'TypeError', 'TypeError'], 1, ['count', 'increment'], true])
  })

  it.each([
    'export let x = 0; export function update() { let o = null; [x, o.y] = [1, 2]; }',
    'export let x = 0; export function update() { for ([x] of [[1]]) {} }',
  ])('rejects exported destructuring writes before partial updates can be lost: %s', source => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptvm-module-destructuring-'))
    directories.push(dir)
    const file = path.join(dir, 'entry.mjs')
    fs.writeFileSync(file, source)
    expect(() => transform(file, { format: 'esm' })).toThrow(/Destructuring.*exported binding/)
  })

  it('rejects imports of missing or ambiguous exports', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptvm-module-missing-'))
    directories.push(dir)
    fs.writeFileSync(path.join(dir, 'entry.mjs'), "import { missing } from './other.mjs'; export { missing };")
    fs.writeFileSync(path.join(dir, 'other.mjs'), 'export const value = 1;')
    expect(() => transform(path.join(dir, 'entry.mjs'), { format: 'esm' })).toThrow('no unambiguous export')
  })

  it('isolates bridges between separately compiled modules', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptvm-module-isolation-'))
    directories.push(dir)
    for (const name of ['first', 'second']) {
      const input = path.join(dir, `${name}.mjs`)
      fs.writeFileSync(input, 'export let count = 1; export function increment() { count++; }')
      fs.writeFileSync(path.join(dir, `${name}.vm.mjs`), transform(input, { format: 'esm' }))
    }
    const run = (suffix: string) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
      const first = await import(${JSON.stringify(pathToFileURL(path.join(dir, 'first')).href)} + ${JSON.stringify(suffix)});
      const second = await import(${JSON.stringify(pathToFileURL(path.join(dir, 'second')).href)} + ${JSON.stringify(suffix)});
      first.increment(); second.increment(); first.increment();
      process.stdout.write(JSON.stringify([first.count, second.count]));
    `], { encoding: 'utf8', timeout: 10_000 }))
    expect(run('.vm.mjs')).toEqual(run('.mjs'))
    expect(run('.vm.mjs')).toEqual([3, 2])
  })

  it('rejects circular dependencies explicitly', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptvm-module-cycle-'))
    directories.push(dir)
    fs.writeFileSync(path.join(dir, 'entry.mjs'), "import './other.mjs'; export let value = 1;")
    fs.writeFileSync(path.join(dir, 'other.mjs'), "import './entry.mjs';")
    expect(() => transform(path.join(dir, 'entry.mjs'), { format: 'esm' })).toThrow('Circular dependency')
  })
})
