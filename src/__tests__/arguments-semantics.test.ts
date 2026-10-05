import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { transform } from '../index'
import { compileSource } from '../core'
import { expectEquivalent } from './differential'

describe('arguments object parameter maps', () => {
  it('maps simple sloppy parameters in both directions including captured writes', () => {
    expectEquivalent(`
      function f(a, b) {
        const args = arguments; const change = value => a = value;
        a = 2; const result = [args[0]]; args[1] = 4; result.push(b);
        change(7); result.push(args[0]); return result;
      }
      globalThis.__result = f(1, 3);
    `)
  })
  it('maps only the last occurrence of duplicate formal names', () => {
    expectEquivalent(`
      function f(a, a) {
        const result = [a, arguments[0], arguments[1]];
        a = 8; result.push(arguments[0], arguments[1]);
        arguments[0] = 9; result.push(a); arguments[1] = 10; result.push(a);
        return result;
      }
      globalThis.__result = [f(1, 2), f(1), f()];
    `)
  })
  it('does not map missing actual arguments or extra arguments', () => {
    expectEquivalent(`
      function f(a, b) { a = 7; b = 8; arguments[1] = 9; return [a, b, [...arguments], arguments.length]; }
      globalThis.__result = [f(1), f(1, 2, 3), f()];
    `)
  })
  it('disconnects a deleted index without losing earlier argument writes', () => {
    expectEquivalent(`
      function f(a) {
        arguments[0] = 2; delete arguments[0]; const result = [a, 0 in arguments];
        arguments[0] = 3; result.push(a); a = 4; result.push(arguments[0]); return result;
      }
      globalThis.__result = f(1);
    `)
  })
  it('disconnects accessor descriptors while keeping parameter values', () => {
    expectEquivalent(`
      function f(a) {
        a = 2;
        Object.defineProperty(arguments, '0', { get() { return 7; }, set(value) { this.written = value; } });
        arguments[0] = 9; a = 3;
        return [a, arguments[0], arguments.written, Object.getOwnPropertyDescriptor(arguments, '0').enumerable];
      }
      globalThis.__result = f(1);
    `)
  })
  it('updates parameters for value descriptors and disconnects writable:false', () => {
    expectEquivalent(`
      function f(a) {
        Object.defineProperty(arguments, '0', { value: 2 }); const result = [a];
        a = 3; result.push(Object.getOwnPropertyDescriptor(arguments, '0').value);
        Object.defineProperty(arguments, '0', { value: 4, writable: false }); result.push(a);
        a = 5; result.push(arguments[0]); return result;
      }
      globalThis.__result = f(1);
    `)
  })
  it('snapshots the current parameter when writable:false omits value', () => {
    expectEquivalent(`
      function f(a) { a = 2; Object.defineProperty(arguments, '0', { writable: false }); a = 3; return [a, arguments[0]]; }
      globalThis.__result = f(1);
    `)
  })
  it('preserves mapping when a descriptor or deletion operation fails', () => {
    expectEquivalent(`
      function f(a) {
        Object.defineProperty(arguments, '0', { configurable: false });
        const result = [Reflect.deleteProperty(arguments, '0'), Reflect.defineProperty(arguments, '0', { get() { return 1; } })];
        a = 2; result.push(arguments[0]); arguments[0] = 3; result.push(a); return result;
      }
      globalThis.__result = f(1);
    `)
  })
  it('preserves mapped descriptors through sealing and snapshots on freezing', () => {
    expectEquivalent(`
      function f(a) {
        Object.seal(arguments); a = 2; const result = [arguments[0], Object.isSealed(arguments)];
        Object.freeze(arguments); a = 3; result.push(a, arguments[0], Object.isFrozen(arguments)); return result;
      }
      globalThis.__result = f(1);
    `)
  })
  it('does not change the mapped parameter when Reflect.set uses another receiver', () => {
    expectEquivalent(`
      function f(a) { const other = {}; const ok = Reflect.set(arguments, '0', 7, other); return [ok, a, arguments[0], other[0]]; }
      globalThis.__result = f(1);
    `)
  })
  it('supports Object.assign, iteration and JSON over live mapped values', () => {
    expectEquivalent(`
      function f(a, b) { a = 3; b = 4; return [[...arguments], Array.from(arguments), Object.assign({}, arguments), JSON.stringify(arguments)]; }
      globalThis.__result = f(1, 2);
    `)
  })
  it('provides a mutable implicit binding that shadows outer arguments bindings', () => {
    expectEquivalent(`
      var arguments = 'outer';
      function f(a) { const original = arguments; arguments = ['changed']; return [arguments[0], original[0]]; }
      function g(a) { var arguments; return arguments[0]; }
      function h(a) { function arguments() { return 4; } return arguments(); }
      globalThis.__result = [f(1), g(2), h(3), arguments];
    `)
  })
  it('honors explicit parameters and lexical bindings named arguments', () => {
    expectEquivalent(`
      function f(arguments) { return arguments; }
      function g() { let arguments = 3; return arguments; }
      function h() { const before = arguments[0]; { let arguments = 4; return [before, arguments]; } }
      globalThis.__result = [f(2), g(), h(1)];
    `)
  })
  it('keeps escaped argument maps alive after the function returns', () => {
    expectEquivalent(`
      function f(a) { return [arguments, () => a, value => a = value]; }
      const result = f(1); result[0][0] = 2; const first = result[1](); result[2](3);
      globalThis.__result = [first, result[0][0]];
    `)
  })
  it('creates independent argument maps for recursive invocations', () => {
    expectEquivalent(`
      function f(a) { const own = arguments; if (a > 0) { const child = f(a - 1); a = 8; return [own[0], child]; } return own[0]; }
      globalThis.__result = f(2);
    `)
  })
  it('supports generator argument maps from eager defaults through suspension', () => {
    expectEquivalent(`
      function* g(a) { a = 2; yield arguments[0]; arguments[0] = 3; return a; }
      const iterator = g(1); globalThis.__result = [iterator.next(), iterator.next()];
    `)
  })
})

describe('arguments object reflection and unmapped behavior', () => {
  it('has the standard own keys, property flags, iterator and prototype', () => {
    expectEquivalent(`
      function f(a) {
        const index = Object.getOwnPropertyDescriptor(arguments, '0');
        const length = Object.getOwnPropertyDescriptor(arguments, 'length');
        const callee = Object.getOwnPropertyDescriptor(arguments, 'callee');
        const iterator = Object.getOwnPropertyDescriptor(arguments, Symbol.iterator);
        return [Object.keys(arguments), Object.getOwnPropertyNames(arguments), Object.getOwnPropertySymbols(arguments).map(String),
          index, length, [callee.value === f, callee.writable, callee.enumerable, callee.configurable],
          [iterator.value === Array.prototype.values, iterator.writable, iterator.enumerable, iterator.configurable],
          Object.getPrototypeOf(arguments) === Object.prototype, Array.isArray(arguments), Object.prototype.toString.call(arguments)];
      }
      globalThis.__result = f(1, 2);
    `)
  })
  it('allows explicit Symbol.toStringTag overrides without adding a hidden own tag', () => {
    expectEquivalent(`
      function f() { const before = Object.prototype.hasOwnProperty.call(arguments, Symbol.toStringTag);
        arguments[Symbol.toStringTag] = 'Custom'; return [before, arguments[Symbol.toStringTag], Object.prototype.toString.call(arguments)]; }
      globalThis.__result = f();
    `)
  })
  it('provides the actual callee in sloppy simple functions, including zero arguments', () => {
    expectEquivalent(`
      const named = function self() { return [arguments.callee === self, arguments.length]; };
      function f(a) { return [arguments.callee === f, arguments.length]; }
      globalThis.__result = [named(), f(), f(1)];
    `)
  })
  it('uses native unmapped arguments with throwing callee in strict functions', () => {
    expectEquivalent(`
      function f(a) { 'use strict';
        a = 2; const result = [arguments[0]]; arguments[0] = 3; result.push(a);
        const descriptor = Object.getOwnPropertyDescriptor(arguments, 'callee');
        result.push(descriptor.get === descriptor.set, descriptor.enumerable, descriptor.configurable,
          Object.prototype.toString.call(arguments), arguments[Symbol.toStringTag]);
        try { arguments.callee; } catch(error) { result.push(error.name); } return result;
      }
      globalThis.__result = f(1);
    `)
  })
  it('does not map default, destructured or rest parameters in sloppy functions', () => {
    expectEquivalent(`
      function f(a = 1) { a = 2; arguments[0] = 3; let error; try { arguments.callee; } catch(e) { error = e.name; } return [a, arguments[0], error]; }
      function g({a}) { a = 2; return [a, arguments[0].a]; }
      function h(a, ...rest) { a = 3; arguments[1] = 4; return [a, arguments[0], rest]; }
      globalThis.__result = [f(1), g({a: 1}), h(1, 2)];
    `)
  })
  it('keeps the argument object shared between parameter defaults and the body', () => {
    expectEquivalent(`
      function f(a = () => arguments, b = arguments.length) { return [a() === arguments, b, [...arguments]]; }
      globalThis.__result = f(undefined, undefined, 3);
    `)
  })
  it('initializes body var arguments from the parameter environment for non-simple functions', () => {
    expectEquivalent(`
      function f(a = () => arguments) { var arguments; return [a() === arguments, arguments.length]; }
      function g(a = () => arguments) { var arguments = 4; return [a().length, arguments]; }
      function outer(value) { return ((a = () => arguments) => { var arguments; return [a()[0], arguments]; })(); }
      globalThis.__result = [f(), g(), outer(7)];
    `)
  })
  it('captures arguments lexically inside arrows and allows reassignment', () => {
    expectEquivalent(`
      function f(a) { const read = () => arguments[0]; const nested = () => () => arguments[0]; arguments = [3]; return [read(), nested()()]; }
      globalThis.__result = f(1);
    `)
  })
  it('creates mapped indexes without consulting a replaced global String', () => {
    expectEquivalent(`
      const originalString = String;
      let result;
      function ordinary(a) {
        a = 2;
        const before = arguments[0];
        arguments[0] = 3;
        return [before, a, Object.getOwnPropertyDescriptor(arguments, '0').value];
      }
      try { globalThis.String = undefined; result = ordinary(1); }
      finally { globalThis.String = originalString; }
      globalThis.__result = result;
    `)
  })
  it('uses captured iterator symbols after user code replaces the global Symbol', () => {
    expectEquivalent(`
      const originalSymbol = Symbol;
      const iteratorKey = Symbol.iterator;
      let result;
      function ordinary(a) { a = 2; return [arguments[0], typeof arguments[iteratorKey], Object.getOwnPropertySymbols(arguments).length]; }
      function* generator(a) { a = 3; yield arguments[0]; return typeof arguments[iteratorKey]; }
      try {
        globalThis.Symbol = undefined;
        const iterator = generator(1);
        result = [ordinary(1), iterator.next(), iterator.next()];
      } finally { globalThis.Symbol = originalSymbol; }
      globalThis.__result = result;
    `)
  })
  it('works when user code replaces Object helper methods after initialization', () => {
    expectEquivalent(`
      const original = Object.defineProperty; let result;
      function f(a) { a = 2; return arguments[0]; }
      try { Object.defineProperty = () => { throw new Error('overridden'); }; result = f(1); }
      finally { Object.defineProperty = original; }
      globalThis.__result = result;
    `)
  })
})

it('preserves source argument semantics when output runs as a native ESM module', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptvm-arguments-esm-'))
  try {
    for (const [extension, source] of [
      ['js', `function f(a) { a = 2; const result = [arguments[0], arguments.callee === f]; Object.freeze(arguments); a = 3; result.push(arguments[0], a); return result; } globalThis.__result = f(1);`],
      ['mjs', `export function f(a) { a = 2; const result = [arguments[0]]; try { arguments.callee; } catch(error) { result.push(error.name); } return result; } globalThis.__result = f(1);`],
      ['async.js', `async function f(a) { await 0; a = 2; return [arguments[0], arguments.callee === f]; } globalThis.__result = f(1);`],
    ] as const) {
      const input = path.join(directory, `input.${extension}`)
      const output = path.join(directory, 'compiled.mjs')
      fs.writeFileSync(input, source)
      fs.writeFileSync(output, extension === 'mjs' ? transform(input, { format: 'esm' }) : compileSource(source).code)
      const observe = (file: string) => execFileSync(process.execPath, ['-e', `import(${JSON.stringify(file)}).then(async () => process.stdout.write(JSON.stringify(await globalThis.__result)))`], { encoding: 'utf8', timeout: 10_000 })
      expect(observe(output)).toEqual(observe(input))
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
