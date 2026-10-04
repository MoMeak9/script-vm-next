import { describe, it } from 'vitest'
import { expectEquivalent } from './differential'

describe('named function expression environments', () => {
  it('recurses through the private name after the outer binding changes', () => {
    expectEquivalent(`
      let factorial = function self(n) { return n > 1 ? n * self(n - 1) : 1; };
      const saved = factorial; factorial = null;
      globalThis.__result = [saved(5), typeof self];
    `)
  })
  it('keeps each expression evaluation and its captured self binding distinct', () => {
    expectEquivalent(`
      const functions = [];
      for (let i = 0; i < 3; i++) functions.push(function self() { return [i, self === functions[i]]; });
      globalThis.__result = functions.map(fn => fn());
    `)
  })
  it('allows parameters and body vars to shadow the private name', () => {
    expectEquivalent(`
      const parameter = function self(self) { return self; };
      const variable = function self() { const before = self; var self = 4; return [before, self]; };
      const lexical = function self() { let self = 5; return self; };
      globalThis.__result = [parameter(3), variable(), lexical()];
    `)
  })
  it('exposes self to defaults without exposing body declarations', () => {
    expectEquivalent(`
      const f = function self(read = () => self) { var self = 3; return [read() === f, self]; };
      const g = function self(self = self) { return self; };
      const result = [f()]; try { g(); } catch(error) { result.push(error.name); }
      globalThis.__result = result;
    `)
  })
  it('ignores sloppy assignments and rejects strict assignments to a private name', () => {
    expectEquivalent(`
      const sloppy = function self() { const assigned = self = 1; return [self === sloppy, assigned]; };
      const strict = function self() { 'use strict'; self = 1; };
      const nested = function self() { return function() { 'use strict'; self = 1; }; };
      const result = [sloppy()];
      for (const f of [strict, nested()]) { try { f(); } catch (error) { result.push(error.name); } }
      globalThis.__result = result;
    `)
  })
  it('provides a self binding for generator expressions', () => {
    expectEquivalent(`
      const f = function* self(n) { if (n) yield* self(n - 1); yield n; };
      globalThis.__result = [...f(3)];
    `)
  })
})

describe('block function declaration instantiation', () => {
  it('initializes strict block functions at block entry without leaking', () => {
    expectEquivalent(`
      'use strict';
      const result = [];
      { result.push(f()); function f() { return 1; } }
      result.push(typeof f);
      globalThis.__result = result;
    `)
  })
  it('instantiates functions in try, catch, and finally blocks', () => {
    expectEquivalent(`
      'use strict'; const result = [];
      try { result.push(f()); function f() { return 1; } throw 5; }
      catch (value) { result.push(f()); function f() { return value; } }
      finally { result.push(f()); function f() { return 3; } }
      result.push(typeof f); globalThis.__result = result;
    `)
  })
  it('gives each loop iteration a distinct closure and mutable block binding', () => {
    expectEquivalent(`
      'use strict'; const functions = [];
      for (let i = 0; i < 3; i++) { functions.push(f); function f() { return i; } }
      let inside; { function f() { return 1; } f = () => 7; inside = f(); }
      globalThis.__result = [functions.map(f => f()), inside, typeof f];
    `)
  })
  it('instantiates all switch functions before case tests in the switch scope', () => {
    expectEquivalent(`
      'use strict'; let result;
      switch (1) {
        case f(): result = f(); break;
        default: function f() { return 1; }
      }
      const outer = 2; switch (outer) { case 2: result += outer; }
      globalThis.__result = [result, typeof f];
    `)
  })
  it('preserves ordinary function-body hoisting and the final duplicate declaration', () => {
    expectEquivalent(`
      function outer() { return f(); function f() { return 1; } function f() { return 2; } }
      globalThis.__result = outer();
    `)
  })
  it('copies sloppy block functions to the outer var only when reached', () => {
    expectEquivalent(`
      function outer(enter) {
        const result = [typeof f];
        if (enter) { result.push(f()); function f() { return 1; } }
        result.push(typeof f, f && f()); return result;
      }
      globalThis.__result = [outer(false), outer(true)];
    `)
  })
  it('copies the current block binding at the declaration evaluation point', () => {
    expectEquivalent(`
      function outer() {
        var f = 'before'; const result = [f];
        { f = () => 2; function f() { return 1; } result.push(f()); }
        result.push(f()); return result;
      }
      globalThis.__result = outer();
    `)
  })
  it('does not synthesize Annex B vars across lexical or parameter conflicts', () => {
    expectEquivalent(`
      function withParameter(f) { { function f() { return 1; } } return f; }
      function withLexical() { let f = 2; { function f() { return 1; } } return f; }
      function nestedLexical() { let result; { let f = 3; { function f() { return 1; } } result = f; } return [result, typeof f]; }
      globalThis.__result = [withParameter(4), withLexical(), nestedLexical()];
    `)
  })
  it('handles sloppy conditional declarations and duplicate block declarations', () => {
    expectEquivalent(`
      function outer() {
        if (true) function f() { return 1; }
        const result = [f()];
        { result.push(g()); function g() { return 2; } function g() { return 3; } }
        result.push(g()); return result;
      }
      globalThis.__result = outer();
    `)
  })
  it('enforces a captured block lexical TDZ before its declaration', () => {
    expectEquivalent(`
      'use strict'; const result = [];
      { function f() { value = 1; }
        try { f(); } catch(error) { result.push(error.name); }
        let value; result.push(value); }
      globalThis.__result = result;
    `)
  })
  it('hoists labeled declarations at the surrounding declaration scope', () => {
    expectEquivalent(`
      function outer() { const result = [typeof f]; label: function f() { return 1; }
        { result.push(g()); label: function g() { return 2; } }
        result.push(f(), g()); return result; }
      globalThis.__result = outer();
    `)
  })
  it('preserves Annex B copies through a catch parameter and loop scopes', () => {
    expectEquivalent(`
      function outer() {
        try { throw 1; } catch (f) { { function f() { return 2; } } }
        for (let g = 0; g < 1; g++) { function g() { return 3; } }
        return [f(), typeof g];
      }
      globalThis.__result = outer();
    `)
  })
  it('keeps generator and async block declarations lexical even in sloppy code', () => {
    expectEquivalent(`
      { function* g() { yield 1; } async function a() { return 2; } }
      globalThis.__result = [typeof g, typeof a];
    `)
  })
})

describe('anonymous named evaluation', () => {
  it('infers variable, identifier assignment, and static property function names', () => {
    expectEquivalent(`
      const f = function() {}; const arrow = () => 1; const generator = function*() {};
      let assigned; assigned = function() {};
      const object = { normal: function(){}, arrow: () => 1, 'quoted-key': function*(){}, 12: function(){} };
      globalThis.__result = [f.name, arrow.name, generator.name, assigned.name,
        object.normal.name, object.arrow.name, object['quoted-key'].name, object[12].name];
    `)
  })
  it('does not overwrite explicit names or infer through sequences, calls, and members', () => {
    expectEquivalent(`
      const explicit = function actual() {}; const sequence = (0, function() {});
      const object = {}; object.member = function() {};
      function identity(value) { return value; } const call = identity(function() {});
      globalThis.__result = [explicit.name, sequence.name, object.member.name, call.name];
    `)
  })
  it('infers destructuring default names without creating a private self binding', () => {
    expectEquivalent(`
      const {f = function(){ return f; }} = {}; const [arrow = () => 1] = [];
      let assigned; ({assigned = function*(){}} = {});
      const original = f; const inferred = function(){ return typeof inferred; };
      globalThis.__result = [f.name, arrow.name, assigned.name, original() === f, inferred()];
    `)
  })
})
