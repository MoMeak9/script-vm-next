import * as vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { compileSource } from '../core'
import { expectEquivalent } from './differential'

describe('non-simple parameter environments', () => {
  it('keeps later and self-referencing parameters in their temporal dead zone', () => {
    expectEquivalent(`
      var results = [];
      function later(a = b, b = 2) { return a; }
      function self(a = a) { return a; }
      function assignment(a = (b = 4), b = 2) { return a; }
      for (const fn of [later, self, assignment]) {
        try { fn(); } catch (error) { results.push(error.name); }
      }
      globalThis.__result = results;
    `)
  })

  it('initializes defaults and destructured bindings strictly from left to right', () => {
    expectEquivalent(`
      var calls = [];
      function item(value) { calls.push(value); return value; }
      function f({a = item(1)} = {}, b = a + item(2), [c = b + item(3)] = [], ...rest) {
        return [a, b, c, rest];
      }
      globalThis.__result = [f(undefined, undefined, undefined, 8, 9), calls];
    `)
  })

  it('keeps body declarations out of parameter defaults and their closures', () => {
    expectEquivalent(`
      var outside = 10;
      function f(a = () => outside, b = () => bodyOnly, c = () => local) {
        var outside = 20;
        var bodyOnly = 30;
        let local = 40;
        var result = [a(), outside, local];
        try { b(); } catch (error) { result.push(error.name); }
        try { c(); } catch (error) { result.push(error.name); }
        return result;
      }
      globalThis.__result = f();
    `)
  })

  it('gives body var copies separate identity from captured parameter bindings', () => {
    expectEquivalent(`
      function f(a = 1, read = () => a, write = value => a = value) {
        var a;
        var start = a;
        a = 4;
        write(8);
        return [start, a, read()];
      }
      function g(a = 1, read = () => a) {
        function a() { return 5; }
        return [a(), read()];
      }
      globalThis.__result = [f(), g()];
    `)
  })

  it('does not rename a shadowing binding inside a nested function', () => {
    expectEquivalent(`
      var name = 'outer';
      function f(read = () => name) {
        var name = 'body';
        function inner(name) { return name; }
        function captured() { return name; }
        return [read(), name, inner('inner'), captured()];
      }
      globalThis.__result = f();
    `)
  })

  it('does not turn a nested lexical shadow into a separate body var binding', () => {
    expectEquivalent(`
      function f(a = 1, read = () => a) {
        { let a = 10; }
        for (let a = 0; a < 2; a++) {}
        a = 3;
        return read();
      }
      globalThis.__result = f();
    `)
  })

  it('preserves names and shorthand keys when separating body declarations', () => {
    expectEquivalent(`
      function f(a = 1) {
        function named() {}
        class NamedClass {}
        var value = 2;
        return [named.name, NamedClass.name, {value}];
      }
      globalThis.__result = f();
    `)
  })

  it('infers names for anonymous functions, arrows and classes in parameter defaults', () => {
    expectEquivalent(`
      function f(a = function () {}, b = () => 1, c = class {}, {d = () => 2} = {}) {
        return [a.name, b.name, c.name, d.name];
      }
      globalThis.__result = f();
    `)
  })

  it('evaluates supplied values without running defaults and keeps arguments unmapped', () => {
    expectEquivalent(`
      function f(a = 1) { a = 7; return [a, arguments[0], arguments.length]; }
      globalThis.__result = [f(), f(undefined), f(null), f(2)];
    `)
  })

  it('does not rely on a caller-visible Array binding for rest parameters', () => {
    expectEquivalent(`
      function f(Array = null, arguments = 3, ...rest) { return [Array, arguments, rest]; }
      globalThis.__result = f(undefined, undefined, 4, 5);
    `)
  })

  it('preserves lexical this and arguments for arrows with defaults and rest', () => {
    expectEquivalent(`
      function outer(value) {
        return ((a = this.marker, ...rest) => [a, rest, arguments[0]])(undefined, 2, 3);
      }
      globalThis.__result = outer.call({marker: 8}, 11);
    `)
  })

  it('uses the lexical explicit arguments binding inside nested arrows', () => {
    expectEquivalent(`
      function outer(arguments = 9, read = () => arguments) { return [read(), (() => arguments)()]; }
      globalThis.__result = outer();
    `)
  })

  it('preserves new.target through default parameter closures', () => {
    expectEquivalent(`
      function Box(read = () => new.target) { this.correct = read() === Box; }
      globalThis.__result = new Box().correct;
    `)
  })

  it('reports the original function length across defaults, patterns, rest, and methods', () => {
    expectEquivalent(`
      function defaults(a, b = 2, c) {}
      function patterns({a}, [b], c) {}
      function rest(a, ...items) {}
      var arrow = (a, b = 2, c) => 1;
      var object = { method(a, b = 2) { return a + b; } };
      globalThis.__result = [defaults.length, patterns.length, rest.length, arrow.length, object.method.length, object.method(3)];
    `)
  })

  it('initializes generator parameters when called and runs its body only on next', () => {
    expectEquivalent(`
      var log = [];
      function* f(value = (log.push('default'), 3)) { log.push('body'); yield value; }
      var iterator = f();
      var first = log.slice();
      var next = iterator.next();
      globalThis.__result = [first, log, next];
    `)
  })

  it('throws generator parameter errors at the call site', () => {
    expectEquivalent(`
      function* f(a = b, b = 2) { yield a; }
      var result = 'no error';
      try { f(); } catch (error) { result = error.name; }
      globalThis.__result = result;
    `)
  })

  it('closes a destructured parameter iterator before initializing the next parameter', () => {
    expectEquivalent(`
      var log = [];
      var iterable = {
        [Symbol.iterator]() { return {
          next() { log.push('next'); return { value: 3, done: false }; },
          return() { log.push('close'); return { done: true }; }
        }; }
      };
      function f([value], later = log.push('later')) { return value; }
      globalThis.__result = [f(iterable), log];
    `)
  })

  it('handles a destructuring rest target and parameter-to-parameter closures', () => {
    expectEquivalent(`
      function f(a = () => b, b = 4, ...[first, ...tail]) { return [a(), first, tail]; }
      globalThis.__result = f(undefined, undefined, 8, 9, 10);
    `)
  })

  it('initializes async generator defaults synchronously before the first next call', () => {
    expectEquivalent(`
      var calls = [];
      async function* f(value = calls.push('default')) { calls.push('body'); yield value; }
      async function* invalid(a = a) { yield a; }
      f();
      try { invalid(); } catch (error) { calls.push(error.name); }
      globalThis.__result = calls;
    `)
  })

  it('rejects async parameter errors and retains the separate scope across await', async () => {
    const source = `
      var value = 11;
      async function f(read = () => value, a = 3) {
        var value = 20;
        await Promise.resolve();
        return [read(), value, a];
      }
      async function invalid(a = a) { return a; }
      globalThis.__result = Promise.all([f(), invalid().then(() => 'wrong', error => error.name)]);
    `
    const native = vm.createContext({})
    const compiled = vm.createContext({})
    vm.runInContext(source, native, { timeout: 1000 })
    vm.runInContext(compileSource(source).code, compiled, { timeout: 1000 })
    expect(structuredClone(await compiled.__result)).toStrictEqual(structuredClone(await native.__result))
  })
})
