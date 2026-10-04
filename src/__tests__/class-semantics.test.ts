import { describe, it } from 'vitest'
import { expectEquivalent } from './differential'

describe('internal class compatibility', () => {
  it('requires construction even with a forged instance receiver', () => {
    expectEquivalent(`
      class A {}
      var failures = [];
      try { A(); } catch (e) { failures.push(e.name); }
      try { A.call(Object.create(A.prototype)); } catch (e) { failures.push(e.name); }
      globalThis.__result = failures;
    `)
  })

  it('defines nonenumerable configurable methods and paired accessors', () => {
    expectEquivalent(`
      class A {
        method() { return 1; }
        static method() { return 2; }
        get value() { return this._value; }
        set value(value) { this._value = value; }
        'quoted'() { return 3; }
        4() { return 4; }
      }
      var value = new A(); value.value = 9;
      var method = Object.getOwnPropertyDescriptor(A.prototype, 'method');
      var accessor = Object.getOwnPropertyDescriptor(A.prototype, 'value');
      globalThis.__result = [Object.keys(A), Object.keys(A.prototype), value.value,
        method.writable, method.enumerable, method.configurable,
        accessor.enumerable, accessor.configurable, typeof accessor.get, typeof accessor.set,
        value.quoted(), value[4](), Object.getOwnPropertyDescriptor(A, 'prototype').writable];
    `)
  })

  it('makes methods nonconstructable and strict', () => {
    expectEquivalent(`
      class A { method() { return this; } }
      var method = A.prototype.method; var error;
      try { new method(); } catch (e) { error = e.name; }
      globalThis.__result = [method() === undefined, method.call(null) === null,
        method.call(1) === 1, error, Object.hasOwn(method, 'prototype')];
    `)
  })

  it('sets method names and converts computed property keys once', () => {
    expectEquivalent(`
      var calls = 0; var key = { toString() { calls++; return 'computed'; } }; var symbol = Symbol('symbol');
      class A { plain() {} get value() { return 1; } [key]() {} [symbol]() {} }
      globalThis.__result = [calls, A.prototype.plain.name, A.prototype.computed.name,
        A.prototype[symbol].name, Object.getOwnPropertyDescriptor(A.prototype, 'value').get.name];
    `)
  })

  it('inherits static methods and preserves the actual subclass receiver', () => {
    expectEquivalent(`
      class A { static value() { return this.name; } }
      class B extends A {}
      class C extends B {}
      globalThis.__result = [B.value(), C.value(), Object.getPrototypeOf(B) === A,
        new C() instanceof A, new C() instanceof B, new C() instanceof C, Object.keys(B.prototype)];
    `)
  })

  it('uses the receiver for super accessors, writes, compound updates, and calls', () => {
    expectEquivalent(`
      class A {
        get value() { return this._value; }
        set value(v) { this._value = v; }
        method(v) { return this._value + v; }
        static get value() { return this._value; }
        static set value(v) { this._value = v; }
        static method(v) { return this._value + v; }
      }
      class B extends A {
        run() { super.value = 3; var old = super.value++; super.value += 2; return [old, super.value, super.method(4)]; }
        static run() { super.value = 8; return [super.value, super.method(2)]; }
      }
      globalThis.__result = [new B().run(), B.run(), A._value];
    `)
  })

  it('resolves super from the current home-object prototype', () => {
    expectEquivalent(`
      class A { method() { return 1; } }
      class B extends A { method() { return super.method(); } }
      Object.setPrototypeOf(B.prototype, { method() { return 7; } });
      globalThis.__result = new B().method();
    `)
  })

  it('throws when a super property cannot be assigned', () => {
    expectEquivalent(`
      class A {}
      Object.defineProperty(A.prototype, 'value', { value: 1 });
      class B extends A { run() { super.value = 2; } }
      new B().run();
    `)
  })

  it('constructs built-in subclasses with native internal slots and new.target', () => {
    expectEquivalent(`
      class List extends Array { constructor(...values) { super(...values); this.target = new.target.name; } }
      class Bag extends Map {}
      class Failure extends Error {}
      var list = new List(1, 2, 3); var bag = new Bag([['key', 4]]); var error = new Failure('message');
      globalThis.__result = [Array.isArray(list), list.length, list[2], list.target,
        list instanceof List, bag.get('key'), bag instanceof Bag, error.message, error instanceof Error];
    `)
  })

  it('uses replacement objects returned by base constructors', () => {
    expectEquivalent(`
      class A { constructor() { return { value: 2 }; } }
      class B extends A { own = 4; #hidden = 8; constructor() { super(); this.value += this.#hidden; } }
      var b = new B(); globalThis.__result = [b.value, b.own, b instanceof B];
    `)
  })

  it('initializes fields immediately after conditional super calls', () => {
    expectEquivalent(`
      var log = [];
      class A { constructor(value) { log.push(value); } }
      class B extends A {
        value = (log.push('field'), 3);
        constructor(flag) { if (flag) { super('true'); } else { super('false'); } log.push(this.value); }
      }
      new B(true); new B(false); globalThis.__result = log;
    `)
  })

  it.each([
    'this.value = 1; super();',
    'return;',
    'return 1;',
    'super(); return 1;',
    'super(); super();',
  ])('preserves derived constructor errors: %s', body => {
    expectEquivalent(`class A {} class B extends A { constructor() { ${body} } } new B();`)
  })

  it('allows a derived constructor to return an object without calling super', () => {
    expectEquivalent(`class A {} class B extends A { constructor() { return { value: 8 }; } } globalThis.__result = new B().value;`)
  })

  it('evaluates derived return rules after finally completion', () => {
    expectEquivalent(`
      var log = [];
      class A { constructor() { this.value = 2; } }
      class B extends A { constructor() { try { return; } finally { super(); log.push('finally'); } } }
      class C extends A { constructor() { try { return 1; } finally { return { value: 8 }; } } }
      log.push(new B().value, new C().value); globalThis.__result = log;
    `)
  })

  it.each([
    ['break', '{ value: 9 }', ''],
    ['continue', '{ value: 9 }', ''],
    ['break', '9', ''],
    ['continue', '9', ''],
    ['break', '{ value: 9 }', 'return { value: 5 };'],
    ['continue', '{ value: 9 }', 'return { value: 5 };'],
    ['break', '{ value: 9 }', 'return;'],
    ['continue', '{ value: 9 }', 'return;'],
  ])('clears a return cancelled by finally %s (%s; %s)', (completion, value, laterReturn) => {
    expectEquivalent(`
      class A {}
      class B extends A {
        constructor() {
          super();
          for (var i = 0; i < 2; i++) {
            try { return ${value}; } finally { ${completion}; }
          }
          this.value = 3;
          ${laterReturn}
        }
      }
      globalThis.__result = new B().value;
    `)
  })

  it('allows arrows to use derived this after a later super call', () => {
    expectEquivalent(`
      class A { constructor(value) { this.value = value; } }
      class B extends A {
        constructor() { var read = () => this.value; var construct = () => super(3); construct(); this.value = read() + 1; }
      }
      globalThis.__result = new B().value;
    `)
  })

  it('supports null heritage with an explicit returned object', () => {
    expectEquivalent(`
      class A extends null { constructor() { return Object.create(new.target.prototype); } }
      globalThis.__result = [Object.getPrototypeOf(A.prototype) === null, new A() instanceof A];
    `)
  })

  it('validates heritage constructability without invoking the superclass', () => {
    expectEquivalent(`
      var log = [];
      function A() { log.push('constructed'); }
      var Parent = new Proxy(A, { get(target, key) { if (key === 'prototype') log.push('prototype'); return Reflect.get(target, key); } });
      class B extends Parent {}
      var arrow = () => {}; arrow.prototype = {};
      try { class C extends arrow {} } catch (e) { log.push(e.name); }
      globalThis.__result = log;
    `)
  })

  it('does not capture user helper or intrinsic names', () => {
    expectEquivalent(`
      class A { static value() { return 2; } method() { return this.value; } }
      function run(Object, Reflect, TypeError, ReferenceError, _super) {
        class B extends A { constructor() { super(); this.value = 5; } method() { return super.method(); } }
        return [new B().method(), B.value()];
      }
      globalThis.__result = run(null, null, null, null, null);
    `)
  })

  it('keeps private helpers and storage inaccessible to same-named parameters', () => {
    expectEquivalent(`
      class C {
        #value = 2;
        run(__privateFieldGet, __privateFieldSet, __privateFieldRef, _C_value) { return this.#value++; }
      }
      globalThis.__result = new C().run(null, null, null, null);
    `)
  })

  it('keeps generated class references independent of method parameters', () => {
    expectEquivalent(`
      class A { method() { return 3; } static method() { return 4; } }
      class B extends A { method(B) { return super.method(); } static method(B) { return super.method(); } }
      globalThis.__result = [new B().method(null), B.method(null)];
    `)
  })

  it('keeps the inner class name immutable after outer reassignment', () => {
    expectEquivalent(`
      class A { own() { return A; } replace() { A = 1; } }
      var Original = A; var a = new A(); A = 2; var error;
      try { a.replace(); } catch (e) { error = e.name; }
      globalThis.__result = [a.own() === Original, A, error];
    `)
  })

  it('preserves the class-name temporal dead zone while computing method keys', () => {
    expectEquivalent(`class A { [A.name]() {} }`)
  })

  it('keeps class declarations in their block scope and temporal dead zone', () => {
    expectEquivalent(`
      var log = [];
      try { A; } catch (e) { log.push(e.name); }
      class A {}
      { class B {} log.push(typeof B); }
      log.push(typeof B); globalThis.__result = log;
    `)
  })
})
