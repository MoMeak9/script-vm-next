import { execFileSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { compileSource } from '../core'
import { compileProgram } from '../compiler/core-pipeline'
import { parseSource } from '../compiler/frontend'
import { expectEquivalent } from './differential'

describe('class lexical evaluation and constructor inheritance', () => {
  it.each(['', 'constructor(value) { super(value); }', 'constructor(value) { (() => super(value))(); }'])(
    'resolves the current superclass for %s', constructor => {
      expectEquivalent(`
        class A { constructor(value) { this.value = 'A' + value; } }
        class B { constructor(value) { this.value = 'B' + value; this.target = new.target.name; } }
        class C extends A { ${constructor} }
        const before = new C(1);
        Object.setPrototypeOf(C, B);
        const after = new C(2);
        globalThis.__result = [before.value, after.value, after.target, after instanceof C,
          after instanceof A, after instanceof B, Object.getPrototypeOf(C.prototype) === A.prototype];
      `)
    }
  )

  it('preserves a further subclass and Reflect.construct new.target after reparenting', () => {
    expectEquivalent(`
      class A {} class B { constructor() { this.target = new.target; } }
      class C extends A { constructor() { super(); } } class D extends C {}
      Object.setPrototypeOf(C, B);
      const d = new D(); const alternate = Reflect.construct(C, [], D);
      globalThis.__result = [d.target === D, d instanceof D, alternate.target === D, alternate instanceof C];
    `)
  })

  it.each(['Array', 'Map', 'Error'])( 'can dynamically inherit from the built-in %s', builtin => {
    const argumentsSource = builtin === 'Map' ? "[['key', 7]]" : builtin === 'Array' ? '1, 2, 3' : "'message'"
    const observation = builtin === 'Map' ? "Map.prototype.get.call(value, 'key')"
      : builtin === 'Array' ? '[Array.isArray(value), value.length, value[2]]' : 'value.message'
    expectEquivalent(`
      class Base {} class Derived extends Base {}
      Object.setPrototypeOf(Derived, ${builtin});
      const value = new Derived(${argumentsSource});
      globalThis.__result = [${observation}, value instanceof Derived, Object.getPrototypeOf(value) === Derived.prototype];
    `)
  })

  it('uses a proxy replacement constructor without reading its prototype during super()', () => {
    expectEquivalent(`
      const log = []; class A {} class B {}
      const replacement = new Proxy(B, {
        get(target, key, receiver) { log.push('get:' + String(key)); return Reflect.get(target, key, receiver); },
        construct(target, args, newTarget) { log.push([args[0], newTarget.name]); return { replacement: true }; }
      });
      class C extends A { constructor() { super('value'); } }
      Object.setPrototypeOf(C, replacement);
      globalThis.__result = [new C().replacement, log];
    `)
  })

  it.each(['null', '{}', '(() => {})'])( 'rejects a nonconstructor superclass %s after evaluating arguments', replacement => {
    expectEquivalent(`
      const log = []; class A {} class B extends A { constructor() { super(log.push('argument')); } }
      Object.setPrototypeOf(B, ${replacement});
      try { new B(); } catch (e) { log.push(e.name); }
      globalThis.__result = log;
    `)
  })

  it('evaluates computed keys with the surrounding receiver and arguments binding', () => {
    expectEquivalent(`
      function make(first) {
        return class {
          [this.prefix + arguments[0]]() { return 'instance'; }
          static [this.prefix + first]() { return 'static'; }
        };
      }
      const C = make.call({ prefix: 'key:' }, 'original');
      globalThis.__result = [new C()['key:original'](), C['key:original']()];
    `)
  })

  it('captures this, arguments and new.target through an arrow returning a class', () => {
    expectEquivalent(`
      function factory(key) {
        return (() => class { [this.prefix + arguments[0] + (new.target ? ':new' : ':call')]() { return 5; } })();
      }
      factory.prototype.prefix = 'prototype:';
      const A = factory.call({ prefix: 'receiver:' }, 'value'); const B = new factory('value');
      globalThis.__result = [new A()['receiver:value:call'](), new B()['prototype:value:new']()];
    `)
  })

  it('preserves new.target in computed names and heritage', () => {
    expectEquivalent(`
      function factory() {
        return class extends (new.target ? Array : Object) {
          [new.target ? 'constructed' : 'called']() { return new.target; }
          static [new.target ? 'factoryConstructed' : 'factoryCalled']() {}
        };
      }
      const A = factory(); const B = new factory();
      globalThis.__result = [new A().called(), typeof B.prototype.constructed, typeof B.factoryConstructed,
        Array.isArray(new B()), Object.getPrototypeOf(A) === Object];
    `)
  })

  it('uses outer class super in nested class keys and heritage, preserving the receiver', () => {
    expectEquivalent(`
      class Base {
        get key() { return this.prefix + ':key'; }
        get parent() { return Array; }
        static get key() { return this.prefix + ':static'; }
      }
      class Outer extends Base {
        constructor() { super(); this.prefix = 'outer'; }
        make() { return class Inner extends super.parent { [super.key]() { return 3; } }; }
        static make() { return class { [super.key]() { return 5; } }; }
      }
      Outer.prefix = 'Outer';
      const A = new Outer().make(); const B = Outer.make();
      globalThis.__result = [new A()['outer:key'](), Array.isArray(new A()), new B()['Outer:static']()];
    `)
  })

  it('keeps inner class method super distinct from lexical super in its keys', () => {
    expectEquivalent(`
      class A { get key() { return 'method'; } run() { return 'outer'; } }
      class B { run() { return 'inner'; } }
      class Outer extends A {
        make() { return class Inner extends B { [super.key]() { return super.run(); } }; }
      }
      const Inner = new Outer().make(); globalThis.__result = new Inner().method();
    `)
  })

  it('checks derived this when a nested class key actually executes', () => {
    expectEquivalent(`
      class A { constructor() { this.key = 'ready'; } }
      class B extends A {
        constructor() {
          const make = () => class { [this.key]() { return 8; } };
          super(); const C = make(); this.result = new C().ready();
        }
      }
      globalThis.__result = new B().result;
    `)
  })

  it('throws for derived this in a computed key before super()', () => {
    expectEquivalent(`class A {} class B extends A { constructor() { class C { [this.key]() {} } super(); } } new B();`)
  })

  it('evaluates keys and coercions in source order after heritage', () => {
    expectEquivalent(`
      const log = [];
      const key = { [Symbol.toPrimitive](hint) { log.push(hint); return 'value'; } };
      function parent() { log.push('heritage'); return Object; }
      class C extends parent() {
        [(log.push('first'), key)]() { return 1; }
        static [(log.push('second'), 'static')]() { return 2; }
        [(log.push('third'), 'last')]() { return 3; }
      }
      globalThis.__result = [log, new C().value(), C.static(), new C().last()];
    `)
  })

  it('stops key evaluation when a prior key conversion throws', () => {
    expectEquivalent(`
      const log = []; const key = { toString() { log.push('coerce'); throw new RangeError(); } };
      try { class C { [key]() {} [(log.push('unreachable'), 'later')]() {} } }
      catch (e) { log.push(e.name); }
      globalThis.__result = log;
    `)
  })

  it('keeps the inner class name uninitialized during heritage evaluation', () => {
    expectEquivalent(`
      const log = []; let C = Object;
      try { const Value = class C extends C {}; } catch (e) { log.push(e.name); }
      globalThis.__result = log;
    `)
  })

  it('initializes closures over the inner name after computed keys complete', () => {
    expectEquivalent(`
      let read; const C = class Inner { [(read = () => Inner, 'key')]() {} self() { return Inner; } };
      globalThis.__result = [read() === C, new C().self() === C];
    `)
  })

  it('keeps separately evaluated classes and their super homes independent', () => {
    expectEquivalent(`
      class A { run() { return this.value; } }
      const values = [];
      for (let i = 0; i < 3; i++) {
        values.push(class extends A { constructor() { super(); this.value = i; } run() { return super.run(); } });
      }
      globalThis.__result = values.map(C => new C().run());
    `)
  })

  it('supports suspension and resume in class computed keys without losing lexical scope', () => {
    expectEquivalent(`
      function* make() {
        return class Named extends (yield 'heritage') { [yield 'key']() { return Named.name; } };
      }
      const iterator = make(); const log = [iterator.next().value, iterator.next(Object).value];
      const C = iterator.next('method').value;
      globalThis.__result = [log, new C().method()];
    `)
  })

  it('unwinds the class scope when a suspended definition is externally returned', () => {
    expectEquivalent(`
      function* make() {
        try { class C { [yield 'key']() {} } }
        finally { yield typeof C; }
      }
      const iterator = make();
      globalThis.__result = [iterator.next(), iterator.return('cancelled'), iterator.next()];
    `)
  })
  it.each([
    ['unresolved write', "(missingClassKey = 1, 'key')", "typeof missingClassKey"],
    ['readonly write', "(frozen.value = 2, 'key')", 'frozen.value'],
    ['readonly update', "(frozen.value++, 'key')", 'frozen.value'],
    ['nonconfigurable delete', "(delete frozen.value, 'key')", 'frozen.value'],
  ])('keeps computed-key %s strict without changing the surrounding script', (_label, key, observation) => {
    expectEquivalent(`
      const frozen = Object.freeze({ value: 1 }); const log = [];
      try { class C { [${key}]() {} } } catch (error) { log.push(error.name); }
      frozen.value = 3; sloppyClassSentinel = 4;
      globalThis.__result = [log, ${observation}, sloppyClassSentinel];
    `)
  })

  it('evaluates heritage in strict mode and restores the enclosing mode after abrupt completion', () => {
    expectEquivalent(`
      const log = [];
      try { class C extends (missingClassHeritage = 1, Object) {} } catch (error) { log.push(error.name); }
      outerSloppy = 2; globalThis.__result = [log, typeof missingClassHeritage, outerSloppy];
    `)
  })

  it('makes functions created in class computed keys strict while keeping this lexical', () => {
    expectEquivalent(`
      let read;
      function factory() {
        class C { [(read = function () { return this; }, this.key)]() {} }
        return C;
      }
      const C = factory.call({ key: 'method' });
      globalThis.__result = [read() === undefined, typeof C.prototype.method];
    `)
  })

  it('supports await in a computed method key without introducing a function boundary', async () => {
    const source = `
      globalThis.__result = (async function factory() {
        const C = class Named extends (await Promise.resolve(Array)) {
          [await Promise.resolve('method')]() { return Named.name; }
        };
        return [new C().method(), Array.isArray(new C())];
      })();
    `
    const native: { __result?: Promise<unknown> } = {}; const virtual: { __result?: Promise<unknown> } = {}
    runInNewContext(source, native, { timeout: 1000 })
    runInNewContext(compileSource(source).code, virtual, { timeout: 1000 })
    expect(structuredClone(await virtual.__result)).toEqual(structuredClone(await native.__result))
  })

  it('infers names for declarations, assignments and binding defaults', () => {
    expectEquivalent(`
      const Assigned = class {}; let Later; Later = class {};
      const [ArrayDefault = class {}] = []; const { value: ObjectDefault = class {} } = {};
      let AssignmentDefault; [AssignmentDefault = class {}] = [];
      function read(Parameter = class {}) { return Parameter.name; }
      const Named = class Explicit {}; const Empty = [class {}][0];
      globalThis.__result = [Assigned.name, Later.name, ArrayDefault.name, ObjectDefault.name,
        AssignmentDefault.name, read(), Named.name, Empty.name];
    `)
  })

  it('names object property classes using string, number and symbol keys', () => {
    expectEquivalent(`
      let coercions = 0; const key = { toString() { coercions++; return 'computed'; } };
      const symbol = Symbol('description'); const anonymous = Symbol();
      const values = { plain: class {}, 'quoted': class {}, 42: class {},
        [key]: class {}, [symbol]: class {}, [anonymous]: class {} };
      globalThis.__result = [values.plain.name, values.quoted.name, values[42].name,
        values.computed.name, values[symbol].name, values[anonymous].name, coercions];
    `)
  })

  it('sets inferred names before static initialization and lets a static name member override', () => {
    const source = `
      const key = 'computed';
      const values = { [key]: class { static observed = this.name; },
        value: class { static name() { return 7; } },
        [Symbol.for('other')]: class { static name() { return 8; } } };
      globalThis.__result = [values.computed.observed, values.value.name(), values[Symbol.for('other')].name()];
    `
    // NamedEvaluation passes the property key to ClassDefinitionEvaluation,
    // which names the constructor before evaluating its static members.
    // V8 incorrectly overwrites a computed property's static name method.
    // https://tc39.es/ecma262/#sec-runtime-semantics-classdefinitionevaluation
    const sandbox: { __result?: unknown } = {}
    runInNewContext(compileSource(source).code, sandbox, { timeout: 1000 })
    expect(sandbox.__result).toEqual(['computed', 7, 8])
  })

  it('does not introduce a lexical self binding for inferred class names', () => {
    expectEquivalent(`
      let Value = class { read() { return Value; } };
      const instance = new Value(); Value = 7;
      globalThis.__result = instance.read();
    `)
  })

  it.each(['iife', 'cjs', 'esm'] as const)('preserves class lexical evaluation in actual %s output', format => {
    const source = `
      function factory() { return class { [this.key + (new.target ? ':new' : ':call')]() { return 7; } }; }
      factory.prototype.key = 'method'; const C = new factory();
      class A {} class B { constructor() { this.target = new.target.name; } }
      class D extends A {} Object.setPrototypeOf(D, B);
      let failure; try { class Strict { [(missingOutputKey = 1, 'key')]() {} } } catch (error) { failure = error.name; }
      globalThis.__result = [new C()['method:new'](), new D().target, failure, typeof missingOutputKey];
    `
    const code = compileProgram(parseSource(source, 'script'), { format }).code
    const output = execFileSync(process.execPath, [
      '--input-type=' + (format === 'esm' ? 'module' : 'commonjs'), '-e',
      code + '\nconsole.log(JSON.stringify(globalThis.__result));',
    ], { encoding: 'utf8', timeout: 5000 })
    expect(JSON.parse(output)).toEqual([7, 'D', 'ReferenceError', 'undefined'])
  })

  it('places temporary bindings for object expressions in class keys in the surrounding frame', () => {
    expectEquivalent(`
      function make() { return class { [({ get value() { return 'method'; } }).value]() { return this; } }; }
      const C = make(); const object = new C(); globalThis.__result = object.method() === object;
    `)
  })

  it('makes object methods created in class keys strict', () => {
    expectEquivalent(`
      let read; class C { [(read = ({ method() { return this; } }).method, 'key')]() {} }
      globalThis.__result = read() === undefined;
    `)
  })

  it('places computed anonymous-class naming temporaries outside the class method', () => {
    expectEquivalent(`
      const key = 'named';
      function make() { return class { [({ [key]: class {} })[key].name]() { return 4; } }; }
      const C = make(); globalThis.__result = new C().named();
    `)
  })

  it('uses internal symbol descriptions for anonymous class and method names', () => {
    expectEquivalent(`
      const described = Symbol('original'); const anonymous = Symbol();
      Object.defineProperty(Symbol.prototype, 'description', { get() { throw new Error('public getter'); }, configurable: true });
      const values = { [described]: class {}, [anonymous]: class {} };
      class C { [described]() {} get [anonymous]() { return 1; } }
      globalThis.__result = [values[described].name, values[anonymous].name, C.prototype[described].name,
        Object.getOwnPropertyDescriptor(C.prototype, anonymous).get.name];
    `)
  })

  it.each(['super.value', "super[(log.push('expression'), key)]"])( 'rejects deletion of %s before coercing its key', expression => {
    expectEquivalent(`
      const log = []; const key = { toString() { log.push('coercion'); return 'value'; } };
      class A {} class B extends A { run() { return delete ${expression}; } }
      try { new B().run(); } catch (error) { log.push(error.name); }
      globalThis.__result = log;
    `)
  })

  it.each(['super[(log.push(1), key)]', 'delete super[(log.push(1), key)]'])( 'checks uninitialized derived this before evaluating %s', expression => {
    // SuperProperty first calls GetThisBinding, even if its reference will be
    // rejected by delete. V8 skips that early check for delete super[key].
    // https://tc39.es/ecma262/#sec-super-keyword-runtime-semantics-evaluation
    const sandbox: { __result?: unknown } = {}
    runInNewContext(compileSource(`
      const log = []; const key = { toString() { log.push(2); return 'value'; } };
      class A {} class B extends A { constructor() { ${expression}; super(); } }
      try { new B(); } catch (error) { log.push(error.name); }
      globalThis.__result = log;
    `).code, sandbox, { timeout: 1000 })
    expect(sandbox.__result).toEqual(['ReferenceError'])
  })

  // Modern GetValue/PutValue cache a Super Reference's converted key, and
  // MakeSuperPropertyReference captures its base before key coercion. Current
  // V8 differs for these combinations, so use the specification as the oracle.
  // https://tc39.es/ecma262/#sec-getvalue
  // https://tc39.es/ecma262/#sec-putvalue
  // https://tc39.es/ecma262/#sec-makesuperpropertyreference
  it('coerces super keys once for each compound/update reference', () => {
    const sandbox: { __result?: unknown } = {}
    runInNewContext(compileSource(`
      const log = []; const key = { toString() { log.push('key'); return 'value'; } };
      class A {
        get value() { log.push('get'); return this.saved || 1; }
        set value(value) { log.push('set:' + value); this.saved = value; }
      }
      class B extends A {
        run() { super[key] += (log.push('rhs'), 2); const old = super[key]++; return [old, this.saved]; }
      }
      globalThis.__result = [new B().run(), log];
    `).code, sandbox, { timeout: 1000 })
    expect(sandbox.__result).toEqual([[3, 4], ['key', 'get', 'rhs', 'set:3', 'key', 'get', 'set:4']])
  })

  it('captures the super base before key coercion can replace its prototype', () => {
    const sandbox: { __result?: unknown } = {}
    runInNewContext(compileSource(`
      class A { get value() { return 1; } }
      class B extends A { run(key) { return super[key]; } }
      const key = { toString() { Object.setPrototypeOf(B.prototype, { value: 9 }); return 'value'; } };
      globalThis.__result = new B().run(key);
    `).code, sandbox, { timeout: 1000 })
    expect(sandbox.__result).toBe(1)
  })

  it('rejects a null super base before coercing the property key', () => {
    const sandbox: { __result?: unknown } = {}
    runInNewContext(compileSource(`
      const log = [];
      class C { run() { return super[(log.push('expression'), { toString() { log.push('coercion'); return 'value'; } })]; } }
      Object.setPrototypeOf(C.prototype, null);
      try { new C().run(); } catch (error) { log.push(error.name); }
      globalThis.__result = log;
    `).code, sandbox, { timeout: 1000 })
    expect(sandbox.__result).toEqual(['expression', 'TypeError'])
  })

  it('coerces a simple super assignment key after its right-hand side', () => {
    const sandbox: { __result?: unknown } = {}
    runInNewContext(compileSource(`
      const log = []; const key = { toString() { log.push('coercion'); return 'value'; } };
      class A {} class B extends A { run() { super[key] = (log.push('rhs'), 7); return this.value; } }
      globalThis.__result = [new B().run(), log];
    `).code, sandbox, { timeout: 1000 })
    expect(sandbox.__result).toEqual([7, ['rhs', 'coercion']])
  })

  it('preserves class name descriptors and explicitly named class values', () => {
    expectEquivalent(`
      const values = { ['inferred']: class Explicit {} };
      const Assigned = class {}; const descriptor = Object.getOwnPropertyDescriptor(Assigned, 'name');
      globalThis.__result = [values.inferred.name, descriptor.value, descriptor.writable,
        descriptor.enumerable, descriptor.configurable];
    `)
  })
})
