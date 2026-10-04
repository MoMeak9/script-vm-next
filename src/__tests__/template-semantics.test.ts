import { describe, it } from 'vitest'
import { expectEquivalent } from './differential'

describe('automatic ES2015 template compatibility', () => {
  it('converts interpolated objects with the string hint before the next expression', () => {
    expectEquivalent(`
      const events = [];
      const value = { [Symbol.toPrimitive](hint) { events.push(hint); return hint; } };
      function next() { events.push('next'); return 7; }
      const text = \`a\${value}b\${next()}c\`;
      globalThis.__result = [text, events];
    `)
  })

  it('does not allow Symbol interpolation through the String constructor shortcut', () => {
    expectEquivalent(`globalThis.__result = \`\${Symbol('value')}\`;`)
  })

  it('reuses the object for one template site across calls and closures', () => {
    expectEquivalent(`
      const seen = [];
      function tag(strings) { seen.push(strings); return strings; }
      function make() { return () => tag\`same\`; }
      const first = make(), second = make();
      first(); first(); second();
      globalThis.__result = [seen[0] === seen[1], seen[0] === seen[2]];
    `)
  })

  it('keeps distinct template sites separate even when their text matches', () => {
    expectEquivalent(`
      const tag = strings => strings;
      const first = tag\`same\`, second = tag\`same\`;
      globalThis.__result = first === second;
    `)
  })

  it('freezes cooked and raw arrays with the native raw descriptor', () => {
    expectEquivalent(`
      function tag(strings) {
        const descriptor = Object.getOwnPropertyDescriptor(strings, 'raw');
        return [Object.isFrozen(strings), Object.isFrozen(strings.raw),
          descriptor.writable, descriptor.enumerable, descriptor.configurable,
          Object.keys(strings), strings[0], strings.raw[0]];
      }
      globalThis.__result = tag\`a\\nb\`;
    `)
  })

  it('preserves invalid tagged escapes as undefined cooked values', () => {
    expectEquivalent("function tag(strings) { return [strings[0], strings.raw[0]]; } globalThis.__result = tag`\\unicode`;")
  })

  it('does not resolve compiler helpers through user Object or undefined bindings', () => {
    expectEquivalent(`
      function run(Object, undefined) {
        function tag(strings) { return [strings[0], strings.raw[0]]; }
        return tag\`\\unicode\`;
      }
      globalThis.__result = run(null, 123);
    `)
  })

  it('preserves tag getter order, receiver and substitution evaluation', () => {
    expectEquivalent(`
      const events = [];
      const object = { get tag() {
        events.push('tag');
        return function(strings, value) {
          events.push(this === object, strings[0], value);
        };
      }};
      function value() { events.push('value'); return 7; }
      object.tag\`answer=\${value()}\`;
      globalThis.__result = events;
    `)
  })

  it('keeps cached template data immutable across successive invocations', () => {
    expectEquivalent(`
      function tag(strings) { strings[0] = 'changed'; strings.raw[0] = 'changed'; return [strings[0], strings.raw[0]]; }
      function run() { return tag\`original\`; }
      globalThis.__result = [run(), run()];
    `)
  })

  it('uses captured intrinsics even if user code replaces Object helper methods', () => {
    expectEquivalent(`
      const freeze = Object.freeze, define = Object.defineProperty;
      let result;
      function tag(strings) { return [Object.isFrozen(strings), Object.isFrozen(strings.raw)]; }
      try {
        Object.freeze = () => { throw new Error('user freeze'); };
        Object.defineProperty = () => { throw new Error('user define'); };
        result = tag\`safe\`;
      } finally {
        Object.freeze = freeze; Object.defineProperty = define;
      }
      globalThis.__result = result;
    `)
  })
})
