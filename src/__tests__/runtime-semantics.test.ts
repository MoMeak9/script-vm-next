import * as vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { compileSource } from '../core'
import { compileProgram } from '../compiler/core-pipeline'
import { expectEquivalent } from './differential'

describe('function receiver semantics', () => {
  it('preserves undefined, null, and primitive receivers in strict functions', () => {
    expectEquivalent(`
      function read() { 'use strict'; return this; }
      globalThis.__result = [read(), read.call(null), read.call(3), read.call('x'), read.call(false)];
    `)
  })

  it('inherits strictness and keeps script-level this global', () => {
    expectEquivalent(`
      'use strict';
      function outer() { return function () { return this; }; }
      globalThis.__result = [this === globalThis, outer()(), outer().call(null)];
    `)
  })

  it('boxes primitives and substitutes the realm global for sloppy receivers', () => {
    expectEquivalent(`
      function read() { return [this === globalThis, typeof this, this.valueOf()]; }
      function globalReceiver() { return this === globalThis; }
      globalThis.__result = [globalReceiver(), globalReceiver.call(null), read.call(3), read.call('x'), read.call(false)];
    `)
  })

  it('retains lexical receiver captures in strict and sloppy arrows', () => {
    expectEquivalent(`
      function strict() { 'use strict'; return (() => this).call(7); }
      function sloppy() { return (() => this === globalThis).call(7); }
      globalThis.__result = [strict(), strict.call(null), strict.call(9), sloppy()];
    `)
  })

  it('keeps generator receivers strict across suspension', () => {
    expectEquivalent(`
      function* read() { 'use strict'; yield this; return this; }
      const first = read(); const second = read.call(null); const third = read.call(4);
      globalThis.__result = [first.next(), second.next(), third.next(), third.next()];
    `)
  })

  it('keeps async receivers strict across await', async () => {
    const source = `
      async function read() { 'use strict'; await 0; return this; }
      globalThis.__result = Promise.all([read(), read.call(null), read.call(4)]);
    `
    const context = vm.createContext({})
    vm.runInContext(compileSource(source).code, context)
    expect(Array.from(await context.__result)).toEqual([undefined, null, 4])
  })

  it('uses undefined for ESM top-level this and nested strict calls', () => {
    const context = vm.createContext({})
    vm.runInContext(compileProgram(`
      function read() { return this; }
      globalThis.__result = [this, read(), read.call(null)];
    `, { format: 'esm' }).code, context)
    expect(Array.from(context.__result)).toEqual([undefined, undefined, null])
  })
})

describe('identifier lookup and strict assignments', () => {
  it('throws ReferenceError for an absent identifier read', () => {
    expectEquivalent(`console.log('before'); missingVmBinding; console.log('after');`)
  })

  it('allows typeof absent identifiers without suppressing TDZ errors', () => {
    expectEquivalent(`
      console.log(typeof missingVmBinding);
      console.log(typeof lexical);
      let lexical = 1;
    `)
  })

  it('does not swallow errors from an existing global getter under typeof', () => {
    expectEquivalent(`
      Object.defineProperty(globalThis, 'lookupFailure', { get() { throw new RangeError('getter'); } });
      globalThis.__result = typeof lookupFailure;
    `)
  })

  it('rejects undeclared strict assignment after evaluating its RHS', () => {
    expectEquivalent(`'use strict'; missingVmBinding = console.log('rhs');`)
  })

  it('retains sloppy implicit-global assignment', () => {
    expectEquivalent(`missingVmBinding = 8; globalThis.__result = [missingVmBinding, globalThis.missingVmBinding];`)
  })

  it('resolves explicit undefined and arguments bindings before special values', () => {
    expectEquivalent(`
      function read(undefined, arguments) { return [undefined, arguments]; }
      globalThis.__result = read(3, 4);
    `)
  })
})

describe('inherited enumerable properties', () => {
  it('enumerates inherited keys while suppressing shadowed and nonenumerable keys', () => {
    expectEquivalent(`
      const parent = { inherited: 1, hidden: 2, shadow: 3 };
      const object = Object.create(parent);
      object.own = 4;
      object.shadow = 5;
      Object.defineProperty(object, 'hidden', { value: 6 });
      const keys = [];
      for (const key in object) keys.push(key);
      globalThis.__result = keys;
    `)
  })
})

describe('abrupt control flow and generator cleanup', () => {
  it('unwinds lexical scopes and executes finally on loop break and continue', () => {
    expectEquivalent(`
      const events = [];
      for (let i = 0; i < 4; i++) {
        try {
          let copy = i;
          if (copy === 0) continue;
          if (copy === 2) break;
          events.push(copy);
        } finally { events.push('finally'); }
      }
      globalThis.__result = events;
    `)
  })

  it('runs finally when a labeled break leaves nested lexical blocks', () => {
    expectEquivalent(`
      const events = [];
      outer: { let first = 1; try { let second = 2; events.push(first + second); break outer; }
        finally { events.push(first); }
      }
      globalThis.__result = events;
    `)
  })

  it('lets a finally return override externally requested generator return', () => {
    expectEquivalent(`
      function* read() { try { yield 1; } finally { console.log('cleanup'); return 3; } }
      const iterator = read();
      globalThis.__result = [iterator.next(), iterator.return(9), iterator.next()];
    `)
  })

  it('lets a finally throw override externally requested generator return', () => {
    expectEquivalent(`
      function* read() { try { yield 1; } finally { throw new RangeError('cleanup'); } }
      const iterator = read(); iterator.next();
      try { iterator.return(9); } catch (error) { globalThis.__result = error.name; }
    `)
  })

  it('retains a pending generator return across yielding cleanup', () => {
    expectEquivalent(`
      function* read() { try { yield 1; } finally { yield 2; console.log('cleanup'); } }
      const iterator = read();
      globalThis.__result = [iterator.next(), iterator.return(9), iterator.next()];
    `)
  })

  it('runs nested finally blocks in order when cancelling a generator', () => {
    expectEquivalent(`
      function* read() {
        try { try { yield 1; } finally { console.log('inner'); return 3; } }
        finally { console.log('outer'); return 4; }
      }
      const iterator = read();
      globalThis.__result = [iterator.next(), iterator.return(9)];
    `)
  })

  it('forwards generator throw through catch and finally', () => {
    expectEquivalent(`
      function* read() { try { yield 1; } catch (error) { yield error.name; } finally { console.log('cleanup'); } }
      const iterator = read();
      globalThis.__result = [iterator.next(), iterator.throw(new RangeError('test')), iterator.return(9)];
    `)
  })

  it('executes async generator cleanup after external return', async () => {
    const source = `
      async function* read() { try { yield 1; } finally { await 0; return 4; } }
      globalThis.__result = (async () => { const iterator = read(); return [await iterator.next(), await iterator.return(9)]; })();
    `
    const context = vm.createContext({})
    vm.runInContext(compileSource(source).code, context)
    expect(structuredClone(await context.__result)).toEqual([{ value: 1, done: false }, { value: 4, done: true }])
  })
})

describe('finally control-flow destinations', () => {
  for (const kind of ['ordinary', 'async', 'generator', 'async generator']) {
    for (const pending of ['return', 'throw']) {
      it(`${kind} finally continue overrides a pending ${pending}`, async () => {
        const prefix = kind === 'ordinary' ? 'function' : kind === 'async' ? 'async function'
          : kind === 'generator' ? 'function*' : 'async function*'
        const suspend = kind.includes('generator') ? 'yield i;' : kind === 'async' ? 'await i;' : ''
        const body = `
          const events = [];
          ${prefix} work() {
            for (let i = 0; i < 2; i++) {
              ${suspend}
              try {
                if (i === 0) ${pending === 'return' ? "return 'discarded';" : "throw new Error('discarded');"}
                events.push('body:' + i);
              } finally {
                if (i === 0) continue;
                events.push('finally:' + i);
              }
            }
            return 'after';
          }
        `
        const consume = kind.includes('generator') ? `
          const iterator = work();
          let step = await iterator.next();
          while (!step.done) step = await iterator.next();
          return [step.value, events];
        ` : 'return [await work(), events];'
        const source = body + `globalThis.__result = (async () => { ${consume} })();`
        const native = vm.createContext({})
        const compiled = vm.createContext({})
        vm.runInContext(source, native)
        vm.runInContext(compileSource(source).code, compiled)
        expect(structuredClone(await compiled.__result)).toEqual(structuredClone(await native.__result))
      })
    }
  }
})
