import { describe, it } from 'vitest'
import { expectEquivalent } from './differential'

const assignments = [
  ['+=', '3', '2'], ['-=', '3', '2'], ['*=', '3', '2'], ['**=', '3', '2'],
  ['/=', '9', '2'], ['%=', '9', '2'], ['<<=', '3', '2'], ['>>=', '12', '2'],
  ['>>>=', '-8', '2'], ['|=', '4', '3'], ['&=', '7', '3'], ['^=', '7', '3'],
  ['+=', "'left'", "'right'"], ['+=', '3n', '2n'],
]

for (const isStatic of [false, true]) {
  describe(`${isStatic ? 'static' : 'instance'} private fields`, () => {
    const qualifier = isStatic ? 'static ' : ''
    const instance = isStatic ? 'Counter' : 'new Counter()'

    it.each(assignments)('preserves %s (%s, %s)', (operator, initial, operand) => {
      expectEquivalent(`
        class Counter {
          ${qualifier}#value = ${initial};
          ${qualifier}run() {
            var result = this.#value ${operator} ${operand};
            return [result, this.#value];
          }
        }
        globalThis.__result = (${instance}).run();
      `)
    })

    it.each(['1', "'1'", '1n', 'null', 'true'])('preserves prefix/postfix ToNumeric for %s', (initial) => {
      expectEquivalent(`
        class Counter {
          ${qualifier}#value = ${initial};
          ${qualifier}run() {
            return [this.#value++, ++this.#value, this.#value--, --this.#value, this.#value];
          }
        }
        globalThis.__result = (${instance}).run();
      `)
    })

    it('coerces the current value once and returns the converted postfix value', () => {
      expectEquivalent(`
        class Counter {
          ${qualifier}#value = { valueOf() { console.log('coerce'); return 3; } };
          ${qualifier}run() { return [this.#value++, this.#value]; }
        }
        globalThis.__result = (${instance}).run();
      `)
    })

    it.each([
      ['&&=', '0'], ['&&=', '1'], ['||=', '0'], ['||=', '1'],
      ['??=', 'null'], ['??=', 'undefined'], ['??=', '0'],
    ])('short-circuits %s for %s', (operator, initial) => {
      expectEquivalent(`
        class Counter {
          ${qualifier}#value = ${initial};
          ${qualifier}run() {
            var calls = 0;
            function rhs() { calls++; return 7; }
            var result = this.#value ${operator} rhs();
            return [result, this.#value, calls];
          }
        }
        globalThis.__result = (${instance}).run();
      `)
    })

    it('evaluates the receiver once and before the RHS', () => {
      expectEquivalent(`
        class Counter {
          ${qualifier}#value = 2;
          ${qualifier}run() {
            var self = this;
            function receiver() { console.log('receiver'); return self; }
            function rhs() { console.log('rhs'); return 3; }
            var a = receiver().#value += rhs();
            var b = receiver().#value++;
            var c = --receiver().#value;
            return [a, b, c, this.#value];
          }
        }
        globalThis.__result = (${instance}).run();
      `)
    })

    it('handles private updates in field initializers', () => {
      expectEquivalent(`
        class Counter {
          ${qualifier}#value = '1';
          ${qualifier}first = this.#value++;
          ${qualifier}second = (this.#value += 4);
          ${qualifier}run() { return [this.first, this.second, this.#value]; }
        }
        globalThis.__result = (${instance}).run();
      `)
    })

    it.each(['=', '+=', '++'])('checks the brand at the correct point for %s', (operator) => {
      const assignment = operator === '++'
        ? 'receiver().#value++'
        : `receiver().#value ${operator} rhs()`
      expectEquivalent(`
        class Counter {
          ${qualifier}#value = 1;
          ${qualifier}run() {
            function receiver() { console.log('receiver'); return {}; }
            function rhs() { console.log('rhs'); return 3; }
            return ${assignment};
          }
        }
        globalThis.__result = (${instance}).run();
      `)
    })
  })

  describe(`${isStatic ? 'static' : 'instance'} private accessors`, () => {
    const qualifier = isStatic ? 'static ' : ''
    const instance = isStatic ? 'Counter' : 'new Counter()'

    it('preserves getter, RHS, and setter order and uses the original receiver', () => {
      expectEquivalent(`
        class Counter {
          ${qualifier}get #value() { console.log('get'); return this.storage; }
          ${qualifier}set #value(value) { console.log('set', value); this.storage = value; }
          ${qualifier}storage = '2';
          ${qualifier}run() {
            var self = this;
            function receiver() { console.log('receiver'); return self; }
            function rhs() { console.log('rhs'); return 3; }
            var a = receiver().#value += rhs();
            var b = receiver().#value++;
            var c = ++receiver().#value;
            return [a, b, c, this.storage];
          }
        }
        globalThis.__result = (${instance}).run();
      `)
    })

    it.each([
      ['&&=', '0'], ['&&=', '1'], ['||=', '0'], ['||=', '1'], ['??=', 'null'], ['??=', '0'],
    ])('does not call the setter or RHS unnecessarily for %s with %s', (operator, initial) => {
      expectEquivalent(`
        class Counter {
          ${qualifier}get #value() { console.log('get'); return this.storage; }
          ${qualifier}set #value(value) { console.log('set', value); this.storage = value; }
          ${qualifier}storage = ${initial};
          ${qualifier}run() {
            function rhs() { console.log('rhs'); return 9; }
            return [this.#value ${operator} rhs(), this.storage];
          }
        }
        globalThis.__result = (${instance}).run();
      `)
    })

    it('resolves accessor references to fields and setters declared later', () => {
      expectEquivalent(`
        class Counter {
          ${qualifier}get #value() { return this.#storage; }
          ${qualifier}change() { this.#value += 2; return this.#value++; }
          ${qualifier}set #value(value) { this.#storage = value; }
          ${qualifier}#storage = 3;
          ${qualifier}read() { return this.#storage; }
        }
        var counter = ${instance};
        globalThis.__result = [counter.change(), counter.read()];
      `)
    })

    it('permits short-circuited assignment to a getter-only accessor', () => {
      expectEquivalent(`
        class Counter {
          ${qualifier}get #value() { console.log('get'); return 4; }
          ${qualifier}run() { return this.#value ||= console.log('rhs'); }
        }
        globalThis.__result = (${instance}).run();
      `)
    })

    it('throws at runtime when a getter-only accessor is written', () => {
      expectEquivalent(`
        class Counter {
          ${qualifier}get #value() { console.log('get'); return 4; }
          ${qualifier}run() { return this.#value += console.log('rhs'); }
        }
        globalThis.__result = (${instance}).run();
      `)
    })

    it('throws before the RHS when a setter-only accessor is read', () => {
      expectEquivalent(`
        class Counter {
          ${qualifier}set #value(value) { console.log('set', value); }
          ${qualifier}run() { return this.#value += console.log('rhs'); }
        }
        globalThis.__result = (${instance}).run();
      `)
    })

    it('checks brands before reading an accessor', () => {
      expectEquivalent(`
        class Counter {
          ${qualifier}get #value() { console.log('get'); return 1; }
          ${qualifier}set #value(value) { console.log('set', value); }
          ${qualifier}run() { return ({}).#value += console.log('rhs'); }
        }
        globalThis.__result = (${instance}).run();
      `)
    })
  })
}


describe('private helpers and source bindings', () => {
  it('does not capture a parameter named Object when writing an instance field', () => {
    expectEquivalent(`
      function run(Object) {
        class C {
          #x = 0;
          set(v) { this.#x = v; return this.#x; }
        }
        return [new C().set(3), Object.marker];
      }
      globalThis.__result = run({ marker: 'user object' });
    `)
  })

  it('does not capture a parameter named WeakMap when reading a static field', () => {
    expectEquivalent(`
      function run(WeakMap) {
        class C {
          static #x = 1;
          static run() { return this.#x; }
        }
        return [C.run(), WeakMap.marker];
      }
      globalThis.__result = run({ marker: 'user weak map' });
    `)
  })

  it('keeps user class and function bindings intact', () => {
    expectEquivalent(`
      function Object(value) { return value + 10; }
      class WeakMap {
        static #value = 2;
        static run() { this.#value += Object(1); return this.#value; }
      }
      globalThis.__result = [WeakMap.run(), Object(3)];
    `)
  })

  it('uses native brands and exceptions when their names are shadowed', () => {
    expectEquivalent(`
      function run(Object, WeakMap, WeakSet, TypeError) {
        class C {
          #storage = 0;
          get #x() { return this.#storage; }
          set #x(v) { this.#storage = v; }
          set(v) { this.#x = v; return this.#x++; }
          invalid() { return ({}).#storage += console.log('unreachable'); }
        }
        var value = new C();
        console.log(value.set(3), Object, WeakMap, WeakSet, TypeError);
        return value.invalid();
      }
      globalThis.__result = run(1, 2, 3, 4);
    `)
  })

  it('does not read intrinsic overrides from user global properties', () => {
    expectEquivalent(`
      globalThis['@script-vm/intrinsic/Object'] = {};
      globalThis['@script-vm/intrinsic/WeakMap'] = {};
      class C {
        static #x = 0;
        static run() { return ++this.#x; }
      }
      globalThis.__result = C.run();
    `)
  })
})
