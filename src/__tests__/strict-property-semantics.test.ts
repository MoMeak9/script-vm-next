import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { compileProgram } from '../compiler/core-pipeline'
import { parseSource } from '../compiler/frontend'
import { expectEquivalent } from './differential'

describe('property mutation strictness', () => {
  for (const strict of [false, true]) {
    const directive = strict ? "'use strict';" : ''
    for (const [name, setup, expression] of [
      ['frozen data', 'const o = Object.freeze({ x: 1 });', 'o.x = 2'],
      ['inherited readonly data', 'const o = Object.create(Object.freeze({ x: 1 }));', 'o.x = 2'],
      ['getter-only accessor', 'const o = {}; Object.defineProperty(o, "x", { get() { return 1; } });', 'o.x = 2'],
      ['nonextensible object', 'const o = Object.preventExtensions({});', 'o.x = 2'],
      ['primitive number', 'const o = 3;', 'o.x = 2'],
      ['primitive string index', 'const o = "abc";', 'o[0] = "d"'],
      ['nonconfigurable delete', 'const o = {}; Object.defineProperty(o, "x", { value: 1 });', 'delete o.x'],
      ['primitive string delete', 'const o = "abc";', 'delete o[0]'],
      ['proxy rejected set', 'const o = new Proxy({}, { set() { return false; } });', 'o.x = 2'],
      ['proxy rejected delete', 'const o = new Proxy({}, { deleteProperty() { return false; } });', 'delete o.x'],
      ['compound update', 'const o = Object.freeze({ x: 1 });', 'o.x += 2'],
      ['postfix update', 'const o = Object.freeze({ x: 1 });', 'o.x++'],
    ]) {
      it(`${strict ? 'strict' : 'sloppy'} ${name}`, () => {
        expectEquivalent(`${directive} ${setup}
          try { globalThis.__result = ['value', ${expression}, o.x]; }
          catch (error) { globalThis.__result = ['error', error.name, o.x]; }
        `)
      })
    }
  }

  it('preserves the original receiver for inherited setters, including primitive receivers', () => {
    expectEquivalent(`
      'use strict'; const events = [];
      Object.defineProperty(Number.prototype, 'saved', {
        set(value) { 'use strict'; events.push([typeof this, this, value]); }, configurable: true
      });
      const base = { set x(value) { events.push([this === child, value]); } };
      const child = Object.create(base);
      (7).saved = 9; child.x = 11;
      globalThis.__result = events;
    `)
  })

  it('preserves proxy receivers, key coercion, and assignment value', () => {
    expectEquivalent(`
      'use strict'; const events = [];
      const target = {};
      const proxy = new Proxy(target, {
        set(object, key, value, receiver) { events.push([key, value, receiver === proxy]); return Reflect.set(object, key, value, receiver); },
        deleteProperty(object, key) { events.push(['delete', key]); return Reflect.deleteProperty(object, key); }
      });
      const key = { toString() { events.push('key'); return 'x'; } };
      const result = proxy[key] = (events.push('rhs'), 4);
      delete proxy[key];
      globalThis.__result = [result, events, target.x];
    `)
  })

  it('preserves proxy invariant violations in sloppy code', () => {
    expectEquivalent(`
      const target = Object.freeze({ x: 1 });
      const proxy = new Proxy(target, { set() { return true; } });
      proxy.x = 2;
    `)
  })

  it('preserves exceptions and evaluation order on nullish bases', () => {
    expectEquivalent(`
      const events = []; const key = { toString() { events.push('key'); return 'x'; } };
      try { null[key] = (events.push('rhs'), 1); } catch (e) { events.push(e.name); }
      try { delete undefined[key]; } catch (e) { events.push(e.name); }
      globalThis.__result = events;
    `)
  })

  it('keeps VM mutation helpers independent of overwritten Reflect methods', () => {
    expectEquivalent(`
      'use strict'; const object = { x: 1 };
      Reflect.set = function () { throw new Error('user set'); };
      Reflect.deleteProperty = function () { throw new Error('user delete'); };
      object.x = 2; const assigned = object.x; delete object.x;
      globalThis.__result = [assigned, 'x' in object];
    `)
  })

  for (const prefix of ['function', 'async function', 'function*', 'async function*']) {
    for (const format of ['iife', 'cjs', 'esm'] as const) {
      it(`${prefix} property operations in ${format} output`, async () => {
        // Functions explicitly mark strict/sloppy intent; ESM wrapper strictness
        // must not accidentally make a compiled script's sloppy function strict.
        const source = `
          ${prefix} strict() { 'use strict'; const o = Object.freeze({ x: 1 });
            try { o.x = 2; } catch (error) { return error.name; } return 'missed'; }
          ${prefix} sloppy() { const o = Object.freeze({ x: 1 }); o.x = 2; return o.x; }
          globalThis.__result = (async () => {
            const a = strict(), b = sloppy();
            return [${prefix.includes('*') ? '(await a.next()).value, (await b.next()).value' : 'await a, await b'}];
          })();
        `
        const code = compileProgram(parseSource(source, 'script'), { format }).code
        const output = execFileSync(process.execPath, [
          '--input-type=' + (format === 'esm' ? 'module' : 'commonjs'), '-e',
          code + '\nPromise.resolve(globalThis.__result).then(result => console.log(JSON.stringify(result)));',
        ], { encoding: 'utf8', timeout: 5000 })
        expect(JSON.parse(output)).toEqual(['TypeError', 1])
      })
    }
  }
})
