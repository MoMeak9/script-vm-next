import { describe, it } from 'vitest'
import { expectEquivalent } from './differential'

const iterable = `
  var events = [];
  function sequence(values) {
    return { [Symbol.iterator]: function () {
      var index = 0;
      return {
        next: function () { events.push('next'); return { value: values[index++], done: index > values.length }; },
        return: function () { events.push('close'); return {}; }
      };
    } };
  }
`

describe('iterable destructuring and closing match native JavaScript', () => {
  it('accepts Sets, strings, generators, holes and nested rest patterns', () => {
    expectEquivalent(`
      const [first, ...tail] = new Set([1, 2, 3]);
      const [unicode, next] = '😀z';
      function* values() { yield 10; yield 20; yield 30; }
      const [, middle, ...[last]] = values();
      const [[nested]] = [new Set([7])];
      globalThis.__result = [first, tail, unicode, next, middle, last, nested];
    `)
  })

  it('steps lazily and closes after ordinary and empty patterns', () => {
    expectEquivalent(`${iterable}
      let [a = (events.push('default'), 1), b] = sequence([undefined, 2, 3]);
      const [] = sequence([4]);
      globalThis.__result = [a, b, events];
    `)
  })

  it('does not close an exhausted iterator and caches its next method', () => {
    expectEquivalent(`
      var events = [], gets = 0;
      var source = { [Symbol.iterator]: function () { var index = 0; return {
        get next() { gets++; return function () { events.push('next'); return { done: index++ > 0, value: 3 }; }; },
        return: function () { events.push('close'); return {}; }
      }; } };
      const [a, b = 4, c = 5] = source;
      globalThis.__result = [a, b, c, events, gets];
    `)
  })

  it('does not read value for holes', () => {
    expectEquivalent(`
      var events = [];
      var source = { [Symbol.iterator]: function () { return {
        next: function () { return { done: false, get value() { events.push('value'); return 2; } }; },
        return: function () { events.push('close'); return {}; }
      }; } };
      const [, x] = source;
      globalThis.__result = [x, events];
    `)
  })

  it('closes nested iterators in order when a default throws', () => {
    expectEquivalent(`
      var events = [];
      function source(name, value) { return { [Symbol.iterator]: function () { return {
        next: function () { return { done: false, value: value }; },
        return: function () { events.push(name); throw new RangeError('close'); }
      }; } }; }
      try { const [[a = (function () { throw new TypeError('default'); })()]] = source('outer', source('inner', undefined)); }
      catch (error) { events.push(error.name); }
      globalThis.__result = events;
    `)
  })

  it('closes after an assignment setter throws and preserves the original error', () => {
    expectEquivalent(`${iterable}
      const receiver = { set value(value) { events.push('set:' + value); throw new RangeError('setter'); } };
      try { [receiver.value] = sequence([2, 3]); } catch (error) { events.push(error.name); }
      globalThis.__result = events;
    `)
  })

  it('evaluates assignment references before advancing the iterator', () => {
    expectEquivalent(`${iterable}
      var receiver = {}, a;
      function object() { events.push('object'); return receiver; }
      function key() { events.push('key'); return 'value'; }
      [object()[key()] = (events.push('default'), 8), a] = sequence([undefined, 9]);
      globalThis.__result = [receiver.value, a, events];
    `)
  })

  it('preserves assignment key coercion order and handles nested default patterns', () => {
    expectEquivalent(`${iterable}
      var receiver = {}, value;
      var key = { toString: function () { events.push('key conversion'); return 'x'; } };
      [receiver[key], [value] = new Set([3])] = sequence([2, undefined]);
      globalThis.__result = [receiver.x, value, events];
    `)
  })

  it('rejects noniterable array-like values including empty patterns', () => {
    expectEquivalent(`
      var errors = [];
      for (var source of [null, undefined, { 0: 1, length: 1 }, 4]) {
        try { const [] = source; } catch (error) { errors.push(error.name); }
      }
      globalThis.__result = errors;
    `)
  })

  it('checks iterator results and return results and does not close after a bad step', () => {
    expectEquivalent(`
      var events = [];
      for (const mode of ['next', 'done', 'value', 'return']) {
        const source = { [Symbol.iterator]: function () { return {
          next: function () {
            if (mode === 'next') return 1;
            return { get done() { if (mode === 'done') throw new RangeError(); return false; },
              get value() { if (mode === 'value') throw new SyntaxError(); return 1; } };
          },
          return: function () { events.push('close:' + mode); return 1; }
        }; } };
        try { const [value] = source; events.push(value); } catch (error) { events.push(error.name); }
      }
      globalThis.__result = events;
    `)
  })

  it('preserves let/const scope, TDZ and shadowed host intrinsic names', () => {
    expectEquivalent(`
      var events = [];
      const source = new Set([1, 2]);
      function run(Symbol, Array, Object, Reflect, TypeError, undefined) {
        try { const [self = self] = []; } catch (error) { events.push(error.name); }
        const [a, ...rest] = source;
        try { a = 4; } catch (error) { events.push(error.name); }
        return [a, rest];
      }
      globalThis.__result = [run(0, 0, 0, 0, 0, 99), events];
    `)
  })

  it('supports destructuring in loop initializers and conditional expressions', () => {
    expectEquivalent(`
      var values = [], a;
      for (let [i] = new Set([0]); i < 2; i++) values.push(i);
      var source = [4];
      values.push(false ? ([a] = [3]) : ([a] = source));
      globalThis.__result = [values[0], values[1], values[2] === source, a];
    `)
  })

  it('returns the original RHS in expression positions without reordering effects', () => {
    expectEquivalent(`${iterable}
      var a, b, source = sequence([1, { value: 2 }]);
      function before() { events.push('before'); return 0; }
      function after() { events.push('after'); return 3; }
      var result = [before(), ([a, { value: b }] = source), after()];
      globalThis.__result = [a, b, result[1] === source, events];
    `)
  })

  it('keeps yielded defaults in the generator frame and closes on cancellation', () => {
    expectEquivalent(`${iterable}
      var a;
      function* assign() { var source = sequence([undefined]); var same = ([a = yield 3] = source); return same === source; }
      var generator = assign();
      var first = generator.next(), last = generator.next(4);
      function* bind() { const [value = yield 5] = sequence([undefined]); return value; }
      var other = bind();
      var waiting = other.next(), cancelled = other.return(6);
      globalThis.__result = [first, last, a, waiting, cancelled, events];
    `)
  })

  it('requires objects even for empty patterns and handles computed keys once', () => {
    expectEquivalent(`
      var events = [];
      try { const {} = null; } catch (error) { events.push(error.name); }
      var key = { toString: function () { events.push('key'); return 'x'; } };
      var symbol = Symbol('key'), obj = { x: 1, y: 2, [symbol]: 3 };
      const { [key]: x, ...rest } = obj;
      var target = {};
      ({ y: target.y } = obj);
      globalThis.__result = [events, x, rest.x, rest.y, rest[symbol], target.y];
    `)
  })
})

describe('for-of cleanup and for-in inheritance', () => {
  it('advances after continue and closes after break', () => {
    expectEquivalent(`${iterable}
      var values = [];
      for (const value of sequence([1, 2, 3, 4])) {
        if (value === 1) continue;
        values.push(value);
        if (value === 3) break;
      }
      globalThis.__result = [values, events];
    `)
  })

  it('preserves body errors when return throws and closes when functions return', () => {
    expectEquivalent(`${iterable}
      var source = { [Symbol.iterator]: function () { return {
        next: function () { return { value: 1, done: false }; },
        return: function () { events.push('close-error'); throw new RangeError(); }
      }; } };
      try { for (const value of source) { throw new TypeError(); } }
      catch (error) { events.push(error.name); }
      function run() { for (const value of sequence([2, 3])) return value; }
      globalThis.__result = [run(), events];
    `)
  })

  it('closes inner iterators on labeled continue without closing the outer iterator', () => {
    expectEquivalent(`${iterable}
      var values = [];
      outer: for (const a of sequence([1, 2])) {
        for (const b of sequence([3, 4])) { values.push([a, b]); continue outer; }
      }
      globalThis.__result = [values, events];
    `)
  })

  it('creates per-iteration bindings and destructures iterable loop values', () => {
    expectEquivalent(`
      var callbacks = [];
      for (let [value] of [new Set([1]), new Set([2])]) callbacks.push(function () { return value; });
      globalThis.__result = callbacks.map(function (fn) { return fn(); });
    `)
  })

  it('retains body scopes independently of loop bindings and skips deleted keys', () => {
    expectEquivalent(`
      var values = [];
      for (let value of [1, 2]) { const value = 3; values.push(value); }
      var object = { a: 1, b: 2, c: 3 };
      for (var key in object) { values.push(key); delete object.b; }
      globalThis.__result = values;
    `)
  })

  it('includes inherited enumerable keys while respecting nonenumerable shadows', () => {
    expectEquivalent(`
      var prototype = { inherited: 1, shadow: 2 };
      var object = Object.create(prototype);
      object.own = 3;
      Object.defineProperty(object, 'shadow', { value: 4 });
      var keys = [];
      function run(Object) { for (var key in object) keys.push(key); }
      run(null);
      globalThis.__result = keys;
    `)
  })
})

describe('spread uses the iterable protocol internally', () => {
  it('rejects array-like noniterables and accepts Set and Unicode iterators', () => {
    expectEquivalent(`
      var errors = [];
      var arrayLike = { 0: 1, length: 1 };
      function call() {}
      try { var a = [...arrayLike]; } catch (error) { errors.push(error.name); }
      try { call(...arrayLike); } catch (error) { errors.push(error.name); }
      try { new call(...arrayLike); } catch (error) { errors.push(error.name); }
      const values = [0, ...new Set([1, 2]), ...'😀'];
      globalThis.__result = [values, errors];
    `)
  })

  it('does not depend on Array, Reflect, undefined or callable apply bindings', () => {
    expectEquivalent(`
      const source = new Set([1, 2]);
      function call(a, b) { 'use strict'; return [this, a, b]; }
      call.apply = function () { throw new Error('custom apply'); };
      function Constructor(a, b) { this.sum = a + b; }
      function run(Array, Reflect, undefined) {
        return [[0, ...source, 3], call(...source), new Constructor(...source).sum];
      }
      globalThis.__result = run(null, null, 99);
    `)
  })

  it('preserves literal holes and ignores Symbol.isConcatSpreadable', () => {
    expectEquivalent(`
      Array.prototype[Symbol.isConcatSpreadable] = false;
      var result = [, 1, ...new Set([2, 3]), , 4];
      globalThis.__result = [result.length, 0 in result, 4 in result, result[1], result[2], result[3], result[5]];
    `)
  })

  it('evaluates receivers, method access and spread effects once in order', () => {
    expectEquivalent(`${iterable}
      var receiver = { value: 5, get method() {
        events.push('method');
        return function (a, b) { events.push('call'); return this.value + a + b; };
      } };
      function object() { events.push('object'); return receiver; }
      var call = () => object().method(...sequence([1, 2]));
      globalThis.__result = [call(), events];
    `)
  })
})
