import { gzipSync } from 'node:zlib'
import { createContext, runInContext } from 'node:vm'
import { transformSync } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { compileSource } from '../core'
import { assembleRuntimeSource } from '../compiler/runtime-assembly'
import { generateRuntimeSource } from '../compiler/runtime-gen'

async function observe(code: string, expression = 'globalThis.__result'): Promise<unknown> {
  const context = createContext({})
  runInContext(code, context, { timeout: 1000 })
  const value = await runInContext(expression, context, { timeout: 1000 })
  // Copy values out of their realms without confusing prototype identity with
  // a semantic mismatch. Every fixture below deliberately returns JSON values.
  return JSON.parse(JSON.stringify(value))
}

const semanticCases = [
  {
    name: 'callbacks that run only after the initial VM invocation returns',
    source: `globalThis.__result = (function(value) { return () => ++value; })(2);`,
    expression: '[__result(), __result(), __result()]',
  },
  {
    name: 'nested arrows reading a live mapped outer arguments binding',
    source: `
      function make(value) { return () => () => { value = 7; arguments[0] += 2; return [value, arguments[0], arguments.length]; }; }
      globalThis.__result = make(3)();
    `,
    expression: '__result()',
  },
  {
    name: 'generator default parameters executed synchronously and yielding cleanup',
    source: `
      const events = [];
      function* values(value = (events.push('default'), 3)) {
        try { yield value; } finally { events.push('finally'); yield 4; }
      }
      const iterator = values(), before = events.slice();
      globalThis.__result = [before, iterator.next(), iterator.return(9), iterator.next(), events];
    `,
  },
  {
    name: 'generator delegation and an abrupt finally completion',
    source: `
      function* inner() { try { yield 1; yield 2; } finally { yield 3; } }
      function* outer() { try { return yield* inner(); } finally { return 5; } }
      const iterator = outer();
      globalThis.__result = [iterator.next(), iterator.return(8), iterator.next()];
    `,
  },
  {
    name: 'async closures and asynchronous exceptions',
    source: `
      async function read(value) { try { return await Promise.resolve(value + 1); } finally { globalThis.cleanup = 7; } }
      globalThis.__result = (async () => { const value = await read(4); try { await Promise.reject(new RangeError('expected')); } catch (error) { return [value, cleanup, error.name]; } })();
    `,
  },
  {
    name: 'async generators, eager parameters, sync delegation and return cleanup',
    source: `
      const events = [];
      async function* values(value = (events.push('default'), 2)) {
        try { yield* [value, await Promise.resolve(value + 1)]; } finally { events.push('finally'); }
      }
      const iterator = values(), before = events.slice();
      globalThis.__result = (async () => [before, await iterator.next(), await iterator.return(9), events])();
    `,
  },
  {
    name: 'object super using computed property conversion from another helper family',
    source: `
      const key = { [Symbol.toPrimitive]() { return 'value'; } };
      const parent = { get value() { return this.prefix + 2; } };
      const object = { __proto__: parent, prefix: 5, read() { return super[key]; } };
      globalThis.__result = object.read();
    `,
  },
  {
    name: 'class lowering, derived constructor hoisting and lexical new.target',
    source: `
      class Base { constructor(value) { this.value = value; } read() { return this.value; } }
      class Derived extends Base { constructor() { super(read()); function read() { return 6; } this.target = (() => new.target.name)(); } read() { return super.read() + 1; } }
      const value = new Derived(); globalThis.__result = [value.read(), value.target, value instanceof Base];
    `,
  },
  {
    name: 'iterator closing and array destructuring defaults',
    source: `
      const events = [];
      const iterable = { [Symbol.iterator]() { return { next() { events.push('next'); return { value: undefined, done: false }; }, return() { events.push('return'); return {}; } }; } };
      const [value = 4] = iterable; globalThis.__result = [value, events];
    `,
  },
  {
    name: 'tagged-template cache identity and cooked/raw strings',
    source: `
      const seen = [];
      function tag(strings, value) { seen.push(strings); return [strings[0], strings.raw[0], value, Object.isFrozen(strings), Object.isFrozen(strings.raw)]; }
      function render(value) { return tag\`line\\n\${value}\`; }
      globalThis.__result = [render(3), render(4), seen[0] === seen[1]];
    `,
  },
  {
    name: 'strict property errors with catch and finally',
    source: `
      'use strict'; const object = Object.freeze({ value: 1 }); const events = [];
      try { object.value = 2; } catch (error) { events.push(error.name); } finally { events.push(object.value); }
      try { delete object.value; } catch (error) { events.push(error.name); }
      globalThis.__result = events;
    `,
  },
  {
    name: 'private intrinsics captured before source mutates public operations',
    source: `
      const savedApply = Reflect.apply, savedDefine = Object.defineProperty;
      function fail() { throw new Error('public replacement'); }
      try {
        Reflect.apply = fail; Object.defineProperty = fail;
        class Base { constructor(value) { this.value = value; } read() { return this.value; } }
        class Derived extends Base { read() { return super.read() + 1; } }
        const call = function(value) { return new Derived(value).read(); };
        globalThis.__result = [call(6), Reflect.apply === fail, Object.defineProperty === fail];
      } finally { Reflect.apply = savedApply; Object.defineProperty = savedDefine; }
    `,
  },
]

describe('compile-time runtime assembly semantics', () => {
  it.each(semanticCases)('matches native execution for $name', async ({ source, expression }) => {
    const expected = await observe(source, expression)
    for (const runtime of ['auto', 'full'] as const) {
      expect(await observe(compileSource(source, { runtime }).code, expression), runtime).toEqual(expected)
    }
  })

  it.each(['auto', 'full'] as const)('preserves console receiver, arguments and thrown exceptions in %s', runtime => {
    const calls: unknown[][] = []
    const consoleObject = { log(value: unknown) { calls.push([this === consoleObject, value]); throw new RangeError('host failure'); } }
    const context = createContext({ console: consoleObject })
    expect(() => runInContext(compileSource('console.log("hello")', { runtime }).code, context)).toThrow('host failure')
    expect(calls).toEqual([[true, 'hello']])
  })
})

describe('runtime assembly structure and output size', () => {
  const source = 'console.log("hello")'

  it('actually selects the requested test-suite default without overriding explicit API modes', () => {
    const defaultCode = compileSource(source).code
    expect(defaultCode.includes('executeAsyncGenerator')).toBe(process.env.SCRIPT_VM_TEST_RUNTIME === 'full')
    expect(compileSource(source, { runtime: 'auto' }).code).not.toContain('executeAsyncGenerator')
    expect(compileSource(source, { runtime: 'full' }).code).toContain('executeAsyncGenerator')
  })

  it('omits unrelated executors, helpers, intrinsic snapshots and opcode handlers for console.log', () => {
    const { code } = compileSource(source, { runtime: 'auto' })
    expect(code).toContain('executeSync')
    for (const name of [
      'executeAsync', 'executeGenerator', 'executeAsyncGenerator', 'createArguments',
      'iteratorStart', 'getTemplateObject', 'objectSuperReference', 'classFunctionName',
      'snapshotIntrinsic', 'compilerObject', 'compilerReflect',
    ]) expect(code, name).not.toMatch(new RegExp(`\\b${name}\\b`))
    for (const opcode of ['AWAIT', 'YIELD', 'TRY', 'NEW', 'BINARY', 'UNARY', 'MAKE_FUNCTION', 'ENTER_SCOPE']) {
      expect(code, opcode).not.toMatch(new RegExp(`case\\s+OPCODES\\.${opcode}\\b`))
    }
  })

  it.each([
    ['async', 'async function read() { return await 1; } globalThis.__result = read;', 'executeAsync', ['executeGenerator', 'executeAsyncGenerator']],
    ['generator', 'function* read() { yield 1; } globalThis.__result = read;', 'executeGenerator', ['executeAsync', 'executeAsyncGenerator']],
    ['async generator', 'async function* read() { yield await 1; } globalThis.__result = read;', 'executeAsyncGenerator', ['executeAsync', 'executeGenerator']],
  ])('retains the latent %s executor without unrelated modes', (_name, input, executor, omitted) => {
    const { code } = compileSource(input as string, { runtime: 'auto' })
    expect(code).toMatch(new RegExp(`\\b${executor}\\b`))
    for (const name of omitted as string[]) expect(code, name).not.toMatch(new RegExp(`\\b${name}\\b`))
  })

  it('keeps the complete runtime when full is explicitly requested', () => {
    const { code } = compileSource(source, { runtime: 'full' })
    for (const name of ['executeSync', 'executeAsync', 'executeGenerator', 'executeAsyncGenerator', 'createArguments', 'iteratorStart', 'getTemplateObject']) {
      expect(code, name).toMatch(new RegExp(`\\b${name}\\b`))
    }
  })

  it('reduces simple-program raw, minified and gzip output by at least half', () => {
    const auto = compileSource(source, { runtime: 'auto' }).code
    const full = compileSource(source, { runtime: 'full' }).code
    const minifiedAuto = transformSync(auto, { minify: true, target: 'es2020' }).code
    const minifiedFull = transformSync(full, { minify: true, target: 'es2020' }).code
    expect(Buffer.byteLength(auto)).toBeLessThan(Buffer.byteLength(full) / 2)
    expect(Buffer.byteLength(minifiedAuto)).toBeLessThan(Buffer.byteLength(minifiedFull) / 2)
    expect(gzipSync(minifiedAuto).byteLength).toBeLessThan(gzipSync(minifiedFull).byteLength / 2)
  })
})

describe('runtime assembly rejects incomplete dependencies before execution', () => {
  it('rejects a referenced helper missing from the template', () => {
    const { artifact } = compileSource('console.log("hello")', { runtime: 'full' })
    const template = generateRuntimeSource().replace('function completion(type, value)', 'function removedCompletion(type, value)')
    expect(() => assembleRuntimeSource(template, artifact.runtimeRequirements!)).toThrow(/unbound helper completion/)
  })

  it('rejects a missing handler for an emitted instruction', () => {
    const { artifact } = compileSource('', { runtime: 'full' })
    const template = generateRuntimeSource().replace(/case OPCODES\.LOAD_UNDEFINED:[\s\S]*?break/g, '')
    expect(() => assembleRuntimeSource(template, artifact.runtimeRequirements!)).toThrow(/missing opcode handler LOAD_UNDEFINED/)
  })

  it('rejects a missing selected executor', () => {
    const { artifact } = compileSource('', { runtime: 'full' })
    const template = generateRuntimeSource().replace('function executeSync(', 'function removedExecuteSync(')
    expect(() => assembleRuntimeSource(template, artifact.runtimeRequirements!)).toThrow(/missing sync executor/)
  })

  it('rejects unknown compiler intrinsic dependencies instead of looking them up on the host', () => {
    const { artifact } = compileSource('console.log("hello")', { runtime: 'full' })
    artifact.constantPool[artifact.constantPool.indexOf('console')] = '@script-vm/intrinsic/NotImplemented'
    expect(() => generateRuntimeSource(artifact, 'auto')).toThrow(/missing intrinsic handler.*NotImplemented/)
  })
})
