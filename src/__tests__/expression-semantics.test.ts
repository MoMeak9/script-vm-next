import { describe, it } from 'vitest'
import { expectEquivalent } from './differential'

describe('expression evaluation order', () => {
  it('gets a method before evaluating arguments and retains its receiver', () => {
    expectEquivalent(`
      var receiver = { marker: 7 };
      Object.defineProperty(receiver, 'method', {
        get: function () {
          console.log('get');
          return function (first, second) {
            console.log('call', this.marker, first, second);
            return this.marker + first + second;
          };
        }
      });
      function base() { console.log('base'); return receiver; }
      function key() { console.log('key'); return 'method'; }
      function arg(value) { console.log('arg', value); return value; }
      globalThis.__result = base()[key()](arg(1), arg(2));
    `)
  })

  it('captures an identifier callee before an argument replaces its binding', () => {
    expectEquivalent(`
      function oldFunction(value) { return 'old:' + value; }
      function newFunction(value) { return 'new:' + value; }
      var fn = oldFunction;
      globalThis.__result = fn((fn = newFunction, 'argument'));
    `)
  })

  it('stops before evaluating arguments when a callee getter throws', () => {
    expectEquivalent(`
      var object = {};
      Object.defineProperty(object, 'method', {
        get: function () { console.log('get'); throw new RangeError('getter'); }
      });
      object.method(console.log('argument'));
    `)
  })

  it('evaluates arguments before rejecting a non-callable value', () => {
    expectEquivalent(`
      var fn = { apply: function () { return 'must not be called'; } };
      fn(console.log('argument'));
    `)
  })

  it('calls a function without consulting its own apply property', () => {
    expectEquivalent(`
      function fn(value) { return value + 1; }
      Object.defineProperty(fn, 'apply', {
        get: function () { throw new Error('apply must not be read'); }
      });
      globalThis.__result = fn(8);
    `)
  })

  it('evaluates and captures a constructor before its arguments', () => {
    expectEquivalent(`
      function Box(value) { this.value = value; }
      function Replacement() { this.value = 'replacement'; }
      var holder = {};
      Object.defineProperty(holder, 'Box', {
        get: function () { console.log('constructor'); return Box; }
      });
      function argument() { console.log('argument'); Box = Replacement; return 9; }
      globalThis.__result = new holder.Box(argument()).value;
    `)
  })

  it('does not evaluate constructor arguments after a throwing getter', () => {
    expectEquivalent(`
      var holder = {};
      Object.defineProperty(holder, 'Box', {
        get: function () { console.log('constructor'); throw new RangeError('getter'); }
      });
      new holder.Box(console.log('argument'));
    `)
  })

  it('captures an assignment base and key expression before its RHS', () => {
    expectEquivalent(`
      var original = {};
      var replacement = {};
      var target = original;
      var key = 'before';
      function base() { console.log('base'); return target; }
      function property() { console.log('property'); return key; }
      function rhs() {
        console.log('rhs'); target = replacement; key = 'after'; return 13;
      }
      var result = base()[property()] = rhs();
      globalThis.__result = [result, original.before, replacement.after];
    `)
  })

  it('coerces a simple assignment property key after evaluating the RHS', () => {
    expectEquivalent(`
      var object = {};
      var key = {};
      key[Symbol.toPrimitive] = function (hint) { console.log('key', hint); return 'value'; };
      function rhs() { console.log('rhs'); return 42; }
      globalThis.__result = [object[key] = rhs(), object.value];
    `)
  })

  it('evaluates a null-base assignment RHS before throwing', () => {
    expectEquivalent(`
      function base() { console.log('base'); return null; }
      function key() { console.log('key'); return 'value'; }
      base()[key()] = console.log('rhs');
    `)
  })

  it('does not evaluate an assignment RHS after a throwing base', () => {
    expectEquivalent(`
      function base() { console.log('base'); throw new RangeError('base'); }
      base().value = console.log('rhs');
    `)
  })

  it('preserves getter, RHS, coercion and setter order for compound assignment', () => {
    expectEquivalent(`
      var object = {};
      var key = {};
      key[Symbol.toPrimitive] = function (hint) { console.log('key', hint); return 'value'; };
      Object.defineProperty(object, 'value', {
        get: function () { console.log('get'); return 2; },
        set: function (value) { console.log('set', value); }
      });
      function rhs() { console.log('rhs'); return 3; }
      globalThis.__result = object[key] += rhs();
    `)
  })

  it('keeps member logical assignment short circuits and writes only when needed', () => {
    expectEquivalent(`
      var stored = 0;
      var object = {};
      Object.defineProperty(object, 'value', {
        get: function () { console.log('get'); return stored; },
        set: function (value) { console.log('set', value); stored = value; }
      });
      function base() { console.log('base'); return object; }
      function rhs(value) { console.log('rhs', value); return value; }
      var first = base().value &&= rhs(10);
      var second = base().value ||= rhs(20);
      var third = base().value ??= rhs(30);
      globalThis.__result = [first, second, third, stored];
    `)
  })
})

describe('update expression numeric semantics', () => {
  for (const initial of ["'1'", "''", 'true', 'null', 'undefined', '-0', '2n']) {
    for (const expression of ['value++', '++value', 'value--', '--value']) {
      it(`matches native ${expression} from ${initial}`, () => {
        expectEquivalent(`
          var value = ${initial};
          var result = ${expression};
          globalThis.__result = [result, value, typeof result, typeof value];
        `)
      })
    }
  }

  it('uses the number hint and converts an object to BigInt exactly once', () => {
    expectEquivalent(`
      var value = {};
      value[Symbol.toPrimitive] = function (hint) { console.log('coerce', hint); return 8n; };
      var previous = value++;
      globalThis.__result = [previous, value];
    `)
  })

  it('falls back from valueOf to toString before updating', () => {
    expectEquivalent(`
      var value = {
        valueOf: function () { console.log('valueOf'); return {}; },
        toString: function () { console.log('toString'); return '12'; }
      };
      var previous = value--;
      globalThis.__result = [previous, value];
    `)
  })

  it('evaluates a member receiver and key expression once and preserves accessors', () => {
    expectEquivalent(`
      var object = {};
      var stored = '5';
      Object.defineProperty(object, 'value', {
        get: function () { console.log('get'); return stored; },
        set: function (value) { console.log('set', value); stored = value; }
      });
      function base() { console.log('base'); return object; }
      function key() { console.log('key'); return 'value'; }
      var previous = base()[key()]++;
      var updated = --base()[key()];
      globalThis.__result = [previous, updated, stored];
    `)
  })

  it('preserves property-key coercion around a member update', () => {
    expectEquivalent(`
      var object = { value: 2n };
      var key = {};
      key[Symbol.toPrimitive] = function (hint) { console.log('key', hint); return 'value'; };
      var previous = object[key]++;
      globalThis.__result = [previous, object.value];
    `)
  })

  it('does not invoke a setter if numeric coercion fails', () => {
    expectEquivalent(`
      var object = {};
      Object.defineProperty(object, 'value', {
        get: function () { console.log('get'); return Symbol('invalid'); },
        set: function (value) { console.log('set', value); }
      });
      object.value++;
    `)
  })

  it('propagates a setter exception after numeric coercion', () => {
    expectEquivalent(`
      var object = {};
      Object.defineProperty(object, 'value', {
        get: function () {
          console.log('get');
          return { valueOf: function () { console.log('coerce'); return '3'; } };
        },
        set: function (value) { console.log('set', value); throw new RangeError('setter'); }
      });
      object.value++;
    `)
  })

  it('converts before rejecting a const update', () => {
    expectEquivalent(`
      const value = { valueOf: function () { console.log('coerce'); return '3'; } };
      value++;
    `)
  })

  it('supports BigInt exponentiation and compound exponentiation', () => {
    expectEquivalent(`
      var value = 2n;
      var first = value ** 10n;
      value **= 5n;
      globalThis.__result = [first, value];
    `)
  })

  it('rejects mixed Number and BigInt exponentiation', () => {
    expectEquivalent('globalThis.__result = 2n ** 3;')
  })

  it('uses the same update semantics inside a generator', () => {
    expectEquivalent(`
      function* sequence() {
        var value = '2';
        yield value++;
        return value;
      }
      var iterator = sequence();
      globalThis.__result = [iterator.next(), iterator.next()];
    `)
  })
})
