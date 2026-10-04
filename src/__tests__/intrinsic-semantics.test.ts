import { execFileSync } from 'node:child_process'
import * as vm from 'node:vm'
import { compileSource } from '../core'
import { describe, expect, it } from 'vitest'
import { compileProgram } from '../compiler/core-pipeline'
import { parseSource } from '../compiler/frontend'
import { expectEquivalent } from './differential'

const poison = `function poisoned() { throw new RangeError('replaced public method'); }`

function patched(target: string, property: string, body: string): string {
  return `
    ${poison}
    const saved = ${target}.${property};
    try { ${target}.${property} = poisoned; ${body} }
    finally { ${target}.${property} = saved; }
  `
}

describe('captured VM host operations', () => {
  for (const method of ['apply', 'construct']) {
    it(`keeps ordinary calls and construction independent of Reflect.${method}`, () => {
      expectEquivalent(patched('Reflect', method, `
        const Box = function(value) { this.value = value; };
        const read = function(value) { return value + 1; };
        globalThis.__result = [read(4), new Box(7).value, Reflect.${method} === poisoned];
      `))
    })
  }

  for (const method of ['defineProperty', 'getPrototypeOf', 'setPrototypeOf']) {
    it(`creates functions and generators after Object.${method} changes`, () => {
      expectEquivalent(patched('Object', method, `
        const ordinary = function(value) { return value + 1; };
        const generator = function*() { yield ordinary(3); return 8; };
        const iterator = generator();
        globalThis.__result = [ordinary(2), ordinary.length, iterator.next(), iterator.next()];
      `))
    })
  }

  it('does not call replaced Reflect.set for implicit global assignment', () => {
    expectEquivalent(patched('Reflect', 'set', `
      internalCaptureGlobal = 4;
      globalThis.__result = internalCaptureGlobal;
      delete globalThis.internalCaptureGlobal;
    `))
  })

  it('keeps compiler-generated argument lists and array literals independent of Array.prototype.push', () => {
    expectEquivalent(patched('Array.prototype', 'push', `
      const add = function(a, b) { return a + b; };
      const values = [1, 2, 3];
      globalThis.__result = [values, add(4, 5), add(...values)];
    `))
  })

  it('allocates interpreter frames after the public Array constructor changes', () => {
    expectEquivalent(`
      ${poison} const saved = Array;
      try { globalThis.Array = poisoned;
        const call = function(a) { let b = 3; return [a, b]; };
        globalThis.__result = call(2);
      } finally { globalThis.Array = saved; }
    `)
  })

  for (const method of ['add', 'has']) {
    it(`keeps VM completion bookkeeping independent of WeakSet.prototype.${method}`, () => {
      expectEquivalent(patched('WeakSet.prototype', method, `
        const call = function() { try { return 3; } finally {} };
        const generator = function*() { try { yield 1; } finally { return 4; } };
        const i = generator(); globalThis.__result = [call(), i.next(), i.return(9)];
      `))
    })
  }

  it('preserves parameter and rest copying after Array.prototype.slice changes', () => {
    expectEquivalent(patched('Array.prototype', 'slice', `
      const call = function(first, ...rest) { return [first, rest]; };
      globalThis.__result = call(1, 2, 3);
    `))
  })

  for (const prefix of ['function', 'async function', 'function*', 'async function*']) {
    it(`uses captured calls and constructors in ${prefix} execution`, async () => {
      const source = `
        ${poison} const savedApply = Reflect.apply, savedConstruct = Reflect.construct;
        globalThis.__result = (async () => {
          try {
            Reflect.apply = poisoned; Reflect.construct = poisoned;
            const Box = function(value) { this.value = value; };
            const make = ${prefix}(value) { return new Box(value).value; };
            const result = make(9);
            return ${prefix.includes('*') ? '(await result.next()).value' : 'await result'};
          } finally { Reflect.apply = savedApply; Reflect.construct = savedConstruct; }
        })();
      `
      const native = vm.createContext({}), compiled = vm.createContext({})
      vm.runInContext(source, native, { timeout: 1000 })
      vm.runInContext(compileSource(source).code, compiled, { timeout: 1000 })
      expect(await compiled.__result).toBe(await native.__result)
    })
  }

  it('still exposes public replacements when source explicitly calls them', () => {
    expectEquivalent(`
      ${poison} const savedApply = Reflect.apply, savedDefine = Object.defineProperty;
      const events = [];
      try {
        Reflect.apply = poisoned; Object.defineProperty = poisoned;
        try { Reflect.apply(function(){}, null, []); } catch (e) { events[events.length] = e.name; }
        try { Object.defineProperty({}, 'x', {}); } catch (e) { events[events.length] = e.name; }
        const call = function() { return 42; }; events[events.length] = call();
      } finally { Reflect.apply = savedApply; Object.defineProperty = savedDefine; }
      globalThis.__result = events;
    `)
  })
})

describe('private compiler intrinsic namespaces', () => {
  for (const [target, method] of [
    ['Object', 'create'], ['Object', 'defineProperty'], ['Object', 'getPrototypeOf'], ['Object', 'setPrototypeOf'],
    ['Reflect', 'apply'], ['Reflect', 'construct'], ['Reflect', 'get'], ['Reflect', 'set'],
  ]) {
    it(`keeps class construction and super operations independent of ${target}.${method}`, () => {
      expectEquivalent(patched(target, method, `
        class Base { constructor(value) { this.value = value; } read() { return this.value; }
          get saved() { return this.value; } set saved(value) { this.value = value; } }
        class Derived extends Base { constructor(value) { super(value); } read() { super.saved = 6; return super.read() + super.saved; } }
        const value = new Derived(3);
        globalThis.__result = [value.read(), value instanceof Derived, value instanceof Base];
      `))
    })
  }

  it('preserves class helpers after source replaces global Object and Reflect bindings', () => {
    expectEquivalent(`
      ${poison} const savedObject = Object, savedReflect = Reflect;
      try {
        globalThis.Object = poisoned; globalThis.Reflect = {};
        class Base { constructor(value) { this.value = value; } read() { return this.value; } }
        class Derived extends Base { read() { return super.read() + 1; } }
        globalThis.__result = new Derived(5).read();
      } finally { globalThis.Object = savedObject; globalThis.Reflect = savedReflect; }
    `)
  })

  it('does not change user-visible Object call or construction', () => {
    expectEquivalent(`
      const value = { x: 1 };
      globalThis.__result = [Object(value) === value, new Object(value) === value, Object(3).valueOf()];
    `)
  })
})

for (const format of ['iife', 'cjs', 'esm'] as const) {
  it(`runs captured operations through the actual ${format} output wrapper`, () => {
    const source = `
      const savedApply = Reflect.apply, savedDefine = Object.defineProperty;
      function fail() { throw new Error('public replacement'); }
      try {
        Reflect.apply = fail; Object.defineProperty = fail;
        class Base { constructor(value) { this.value = value; } read() { return this.value; } }
        class Derived extends Base { read() { return super.read() + 1; } }
        const call = function(value) { return new Derived(value).read(); };
        globalThis.__result = call(6);
      } finally { Reflect.apply = savedApply; Object.defineProperty = savedDefine; }
    `
    const code = compileProgram(parseSource(source, 'script'), { format }).code
    const output = execFileSync(process.execPath, [
      '--input-type=' + (format === 'esm' ? 'module' : 'commonjs'), '-e',
      code + '\nconsole.log(JSON.stringify(globalThis.__result));',
    ], { encoding: 'utf8', timeout: 5000 })
    expect(JSON.parse(output)).toBe(7)
  })
}


it('keeps the module notification global proxy independent of Reflect.get and Reflect.has', () => {
  const source = `
    const savedGet = Reflect.get, savedHas = Reflect.has;
    function fail() { throw new Error('public replacement'); }
    try {
      Reflect.get = fail; Reflect.has = fail;
      globalThis.__result = Math.max(3, 7);
    } finally { Reflect.get = savedGet; Reflect.has = savedHas; }
  `
  const code = compileProgram(source, { format: 'iife', notifyIdentifier: '@test/notify' }).code
  const context = vm.createContext({})
  vm.runInContext(code, context, { timeout: 1000 })
  expect(context.__result).toBe(7)
})


describe('captured semantic exception constructors', () => {
  for (const [constructor, operation] of [
    ['ReferenceError', 'let value = value;'],
    ['TypeError', 'const value = 1; value = 2;'],
  ]) {
    it(`uses the original ${constructor} for VM binding errors while public construction stays live`, () => {
      expectEquivalent(`
        const original = ${constructor};
        const replacement = function() { this.replacement = true; };
        try {
          globalThis.${constructor} = replacement;
          const explicit = new ${constructor}();
          try { ${operation} }
          catch (error) { globalThis.__result = [error instanceof original, error.name, explicit.replacement]; }
        } finally { globalThis.${constructor} = original; }
      `)
    })
  }
})
