import { describe, expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { compileSource } from '../core'
import { expectEquivalent } from './differential'

function compileAndRunSource(source: string): unknown {
  const sandbox: Record<string, unknown> = {}
  runInNewContext(compileSource(source).code, sandbox, { timeout: 1000 })
  return structuredClone(sandbox.__result)
}

/** All fixtures execute in independent native realms and compare observable
 * results, side effects and exception names against the VM implementation. */
describe('ES2015 enhanced object literals', () => {
  const fixtures: [string, string][] = [
    ['sets the prototype for identifier and string literal prototype initializers', `
      const base = { inherited: 7 };
      const first = { __proto__: base, own: 8 };
      const second = { '__proto__': null, own: 9 };
      globalThis.__result = [Object.getPrototypeOf(first) === base, first.inherited,
        Object.keys(first), Object.getPrototypeOf(second) === null, Object.keys(second)];
    `],
    ['ignores primitive prototype initializers but evaluates their expression', `
      const values = [undefined, 1, 'text', true, Symbol('value')];
      const results = [];
      for (const value of values) {
        const object = { __proto__: value };
        results.push(Object.getPrototypeOf(object) === Object.prototype, Object.keys(object));
      }
      globalThis.__result = results;
    `],
    ['accepts a function as the prototype without giving it an inferred name', `
      const object = { __proto__: function() {} };
      globalThis.__result = [typeof Object.getPrototypeOf(object), Object.getPrototypeOf(object).name];
    `],
    ['defines computed __proto__ as an own data property', `
      const value = { marker: 1 };
      const object = { ['__proto__']: value };
      const d = Object.getOwnPropertyDescriptor(object, '__proto__');
      globalThis.__result = [Object.getPrototypeOf(object) === Object.prototype,
        d.value === value, d.enumerable, d.writable, d.configurable];
    `],
    ['treats shorthand and method __proto__ as ordinary properties', `
      const __proto__ = 7;
      const first = { __proto__ };
      const second = { __proto__() { return 9; } };
      globalThis.__result = [first.__proto__, second.__proto__(), Object.keys(first), Object.keys(second),
        Object.getPrototypeOf(first) === Object.prototype, Object.getPrototypeOf(second) === Object.prototype];
    `],
    ['defines data properties without invoking inherited setters', `
      const events = [];
      const base = { set value(v) { events.push(v); } };
      const object = { __proto__: base, value: 7 };
      globalThis.__result = [object.value, events, Object.keys(object)];
    `],
    ['coerces computed data keys before evaluating values', `
      const events = [];
      const key = { [Symbol.toPrimitive](hint) { events.push(hint); return 'value'; } };
      const object = { [key]: (events.push('value'), 7) };
      globalThis.__result = [object.value, events];
    `],
    ['stops before the value when key coercion throws', `
      const events = [];
      try { const object = { [{ toString() { events.push('key'); throw new RangeError(); } }]: events.push('value') }; }
      catch (error) { events.push(error.name); }
      globalThis.__result = events;
    `],
    ['preserves computed-key lexical this and arguments', `
      function make(key) { return { [this.prefix + arguments[0]]: 7, method() { return this.value; } }; }
      const object = make.call({ prefix: 'x' }, 'y');
      globalThis.__result = [object.xy, Object.keys(object)];
    `],
    ['preserves computed-key new.target in the enclosing constructor', `
      function Make() { return { [new.target.name]: 7, method() {} }; }
      globalThis.__result = Object.keys(new Make());
    `],
    ['evaluates nested literals, computed keys and values from left to right', `
      const events = [];
      function key(value) { events.push(value); return value; }
      const object = { [key('outer')]: { [key('inner')]: key('value'), method() { return this.inner; } },
        [key('last')]() { return 9; } };
      globalThis.__result = [events, object.outer.method(), object.last()];
    `],
    ['defines method and accessor descriptors and merges accessor pairs', `
      const object = { method() { return 1; }, get value() { return this.storage; }, set value(v) { this.storage = v; } };
      object.value = 7;
      const m = Object.getOwnPropertyDescriptor(object, 'method');
      const a = Object.getOwnPropertyDescriptor(object, 'value');
      globalThis.__result = [object.value, m.enumerable, m.configurable, m.writable,
        a.enumerable, a.configurable, typeof a.get, typeof a.set, 'value' in a];
    `],
    ['handles accessor and data overwrites without retaining stale descriptor fields', `
      const object = { get x() { return 1; }, x: 2, set x(v) { this.saved = v; }, get x() { return this.saved; } };
      object.x = 7;
      globalThis.__result = [object.x, Object.keys(Object.getOwnPropertyDescriptor(object, 'x')).sort()];
    `],
    ['makes ordinary methods and accessors nonconstructable', `
      const object = { method() {}, get value() { return 1; }, set value(v) {} };
      const d = Object.getOwnPropertyDescriptor(object, 'value');
      const result = [];
      for (const fn of [object.method, d.get, d.set]) {
        result.push(Object.prototype.hasOwnProperty.call(fn, 'prototype'));
        try { new fn(); result.push('constructed'); } catch (error) { result.push(error.name); }
      }
      globalThis.__result = result;
    `],
    ['infers string, numeric and symbol method names', `
      const named = Symbol('key'), empty = Symbol(), blank = Symbol('');
      const object = { method() {}, 'quoted'() {}, 7() {}, [named]() {}, [empty]() {}, [blank]() {} };
      globalThis.__result = [object.method.name, object.quoted.name, object[7].name,
        object[named].name, object[empty].name, object[blank].name,
        Object.getOwnPropertyDescriptor(object.method, 'name')];
    `],
    ['prefixes accessor names and retains parameter lengths', `
      const key = Symbol('value');
      const object = { method(a, b = 1, ...rest) {}, get [key]() { return 1; }, set [key](value) {} };
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      globalThis.__result = [object.method.length, descriptor.get.name, descriptor.get.length,
        descriptor.set.name, descriptor.set.length];
    `],
    ['infers anonymous data function and arrow names without renaming referenced functions', `
      const shared = function named() {};
      const symbol = Symbol('value');
      const object = { a: function() {}, b: () => 1, [symbol]: function() {}, c: shared };
      globalThis.__result = [object.a.name, object.b.name, object[symbol].name, object.c.name, shared.name];
    `],
    ['retains sloppy and strict method this behavior', `
      const object = { sloppy() { return this == null ? 'missing' : typeof this; },
        strict() { 'use strict'; return this; } };
      const sloppy = object.sloppy, strict = object.strict;
      globalThis.__result = [sloppy(), sloppy.call(1), strict() === undefined, strict.call(1)];
    `],
    ['uses the method home object and actual receiver for super getters and calls', `
      const base = { get value() { return this.own; }, method(extra) { return this.own + extra; } };
      const object = { __proto__: base, own: 7, read() { return [super.value, super.method(2)]; } };
      const receiver = { own: 20, read: object.read };
      globalThis.__result = [object.read(), receiver.read()];
    `],
    ['looks up a changed home-object prototype dynamically', `
      const first = { value: 1 }, second = { value: 2 };
      const object = { __proto__: first, read() { return super.value; } };
      const method = object.read;
      const before = method();
      Object.setPrototypeOf(object, second);
      globalThis.__result = [before, method(), object.read()];
    `],
    ['captures a distinct home object for every loop evaluation', `
      const objects = [];
      for (let i = 0; i < 3; i++) objects.push({ __proto__: { value: i }, read() { return super.value; } });
      Object.setPrototypeOf(objects[1], { value: 10 });
      globalThis.__result = [objects[0].read(), objects[1].read(), objects[2].read()];
    `],
    ['preserves nested arrow super lookup and lexical receiver', `
      const object = { __proto__: { value() { return this.own; } }, own: 8,
        method() { return () => super.value(); } };
      const arrow = object.method();
      globalThis.__result = arrow.call({ own: 99 });
    `],
    ['keeps nested object method home objects separate', `
      const object = { __proto__: { outer: 1 }, method() {
        const inner = { __proto__: { value: 2 }, method() { return super.value; } };
        return [super.outer, inner.method()];
      } };
      globalThis.__result = object.method();
    `],
    ['evaluates computed super calls and spread arguments once in order', `
      const events = [];
      const base = { get method() { events.push('get'); return function(a, b) { events.push(this.own, a, b); return a + b; }; } };
      const object = { __proto__: base, own: 7, run() {
        return super[(events.push('key'), 'method')](...(events.push('args'), [1, 2]));
      } };
      globalThis.__result = [object.run(), events];
    `],
    ['uses the correct receiver for tagged super templates', `
      const object = { __proto__: { tag(strings, value) { return [this.own, strings[0], value]; } }, own: 7,
        method() { return super.tag\`value=\${2}\`; } };
      globalThis.__result = object.method();
    `],
    ['writes super properties through the actual receiver', `
      const base = { set value(v) { this.own = v; }, get value() { return this.own; } };
      const object = { __proto__: base, own: 1, run() { return super.value = 7; } };
      const receiver = { own: 20, run: object.run };
      globalThis.__result = [receiver.run(), receiver.own, object.own];
    `],
    ['ignores failed sloppy super assignment and rejects failed strict super assignment', `
      const base = {};
      Object.defineProperty(base, 'value', { value: 1 });
      const object = { __proto__: base, sloppy() { return super.value = 2; },
        strict() { 'use strict'; return super.value = 3; } };
      const result = [object.sloppy(), object.value];
      try { object.strict(); } catch (error) { result.push(error.name); }
      globalThis.__result = result;
    `],
    ['inherits surrounding strictness for super writes', `
      'use strict';
      const base = Object.freeze({ value: 1 });
      const object = { __proto__: base, method() { return super.value = 2; } };
      try { object.method(); } catch (error) { globalThis.__result = error.name; }
    `],
    ['rejects delete super after key evaluation without coercing the key', `
      const events = [];
      const object = { method() { return delete super[(events.push('expression'), {
        toString() { events.push('coercion'); return 'value'; }
      })]; } };
      try { object.method(); } catch (error) { events.push(error.name); }
      globalThis.__result = events;
    `],
    ['supports super access inside generator methods', `
      const object = { __proto__: { value: 7 }, *method() { yield super.value; return super.value + 1; } };
      const iterator = object.method();
      globalThis.__result = [object.method.name, iterator.next(), iterator.next()];
    `],
    ['evaluates super in normalized default parameters', `
      const object = { __proto__: { value: 7 }, method(value = super.value) { return value; } };
      globalThis.__result = [object.method(), object.method(9), object.method.length];
    `],
    ['does not expose internal home-object bindings to source identifiers', `
      const _d0 = 11, _d1 = 12, home = 13;
      const object = { __proto__: { value: 7 }, method() { return [_d0, _d1, home, super.value]; } };
      globalThis.__result = object.method();
    `],
    ['uses intrinsics when Object and Reflect are shadowed by parameters', `
      function make(Object, Reflect) {
        return { __proto__: { value: 7 }, data: 8, method() { return super.value; }, get accessor() { return this.data; } };
      }
      const object = make(null, null);
      globalThis.__result = [object.method(), object.accessor, Object.keys(object)];
    `],
    ['uses captured helpers even if user code replaces Object and Reflect methods', `
      const saved = [Object.defineProperty, Object.getPrototypeOf, Object.setPrototypeOf, Reflect.get, Reflect.set];
      let result;
      try {
        Object.defineProperty = Object.getPrototypeOf = Object.setPrototypeOf = Reflect.get = Reflect.set = function() { throw new Error('overridden'); };
        const object = { __proto__: { value: 7 }, method() { return super.value; }, [1]: 2 };
        result = [object.method(), object[1], object.method.name];
      } finally {
        Object.defineProperty = saved[0]; Object.getPrototypeOf = saved[1]; Object.setPrototypeOf = saved[2]; Reflect.get = saved[3]; Reflect.set = saved[4];
      }
      globalThis.__result = result;
    `],
    ['spreads enumerable own string and symbol values without invoking target setters', `
      const events = [];
      const key = Symbol('value');
      const source = { get value() { events.push('get'); return 7; }, [key]: 8, ['__proto__']: 9 };
      Object.defineProperty(source, 'hidden', { value: 10 });
      const object = { __proto__: { set value(v) { events.push('set'); } }, ...source };
      globalThis.__result = [events, object.value, object[key], object.__proto__, Object.keys(object),
        Object.getOwnPropertyDescriptor(object, 'value')];
    `],
    ['spreads null, undefined and primitive values with CopyDataProperties semantics', `
      const object = { ...null, ...undefined, ...false, ...7, ...'ab' };
      globalThis.__result = [Object.keys(object), object[0], object[1]];
    `],
    ['preserves spread proxy trap ordering and skips properties made nonenumerable', `
      const events = [];
      const source = new Proxy({ a: 1, b: 2 }, {
        ownKeys(target) { events.push('keys'); return ['a', 'b']; },
        getOwnPropertyDescriptor(target, key) { events.push('descriptor:' + key); return Object.getOwnPropertyDescriptor(target, key); },
        get(target, key) { events.push('get:' + key); if (key === 'a') Object.defineProperty(target, 'b', { enumerable: false }); return target[key]; }
      });
      const object = { ...source };
      globalThis.__result = [events, Object.keys(object), object.a];
    `],
    ['keeps computed values in a generator activation across suspension', `
      function* make() { return { [yield 'key']: yield 'value', method() { return this.answer; } }; }
      const iterator = make();
      const first = iterator.next(), second = iterator.next('answer'), last = iterator.next(7);
      globalThis.__result = [first, second, last.done, last.value.method()];
    `],
  ]
  for (const [name, source] of fixtures) it(name, () => expectEquivalent(source))

  // These explicit oracles follow ECMA-262 2025 SuperProperty evaluation,
  // MakeSuperPropertyReference, GetValue and PutValue. V8 (including Node
  // 20/24) still repeats key coercion or looks up the super base too late in
  // these cases, so native differential execution is not the correct oracle.
  // https://262.ecma-international.org/16.0/#sec-getvalue
  // https://262.ecma-international.org/16.0/#sec-makesuperpropertyreference
  it('caches the converted key across compound and postfix super writes', () => {
    expect(compileAndRunSource(`
      const events = [];
      const base = { get value() { events.push('get'); return this.own; }, set value(v) { events.push('set', v); this.own = v; } };
      const object = { __proto__: base, own: 2, run() {
        const key = { toString() { events.push('key'); return 'value'; } };
        const added = super[key] += (events.push('rhs'), 3);
        const old = super[key]++;
        return [added, old, this.own];
      } };
      globalThis.__result = [object.run(), events];
    `)).toEqual([[5, 5, 6], ['key', 'get', 'rhs', 'set', 5, 'key', 'get', 'set', 6]])
  })

  it('captures the base before key coercion changes the home-object prototype', () => {
    expect(compileAndRunSource(`
      const first = { value: 1 }, second = { value: 2 };
      const object = { __proto__: first, run() {
        return super[{ toString() { Object.setPrototypeOf(object, second); return 'value'; } }];
      } };
      globalThis.__result = [object.run(), Object.getPrototypeOf(object) === second];
    `)).toEqual([1, true])
  })

  it('throws for a null super base before coercing its key', () => {
    expect(compileAndRunSource(`
      const events = [];
      const object = { __proto__: null, run() {
        return super[(events.push('expression'), { toString() { events.push('coercion'); return 'value'; } })];
      } };
      try { object.run(); } catch (error) { events.push(error.name); }
      globalThis.__result = events;
    `)).toEqual(['expression', 'TypeError'])
  })

  it('delays simple super assignment key coercion until after the right-hand side', () => {
    expectEquivalent(`
      const events = [];
      const object = { run() {
        return super[{ toString() { events.push('key'); return 'value'; } }] = (events.push('rhs'), 7);
      } };
      globalThis.__result = [object.run(), object.value, events];
    `)
  })

  it('captures the assignment base before the right-hand side changes the home prototype', () => {
    expect(compileAndRunSource(`
      const events = [];
      const first = { set value(v) { events.push('first', v); } }, second = { set value(v) { events.push('second', v); } };
      const object = { __proto__: first, run() {
        return super.value = (Object.setPrototypeOf(object, second), 7);
      } };
      globalThis.__result = [object.run(), events];
    `)).toEqual([7, ['first', 7]])
  })

})
