import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { transform } from '../index'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function compareModules(sources: Record<string, string>, observe: (module: any) => unknown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptvm-module-compatibility-'))
  directories.push(dir)
  for (const [name, source] of Object.entries(sources)) fs.writeFileSync(path.join(dir, name), source)
  const entry = path.join(dir, 'entry.mjs')
  const output = path.join(dir, 'compiled.mjs')
  fs.writeFileSync(output, transform(entry, { format: 'esm', bundle: true }))
  const run = (file: string) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    const module = await import(${JSON.stringify(pathToFileURL(file).href)});
    process.stdout.write(JSON.stringify(await (${observe.toString()})(module)));
  `], { encoding: 'utf8', timeout: 10_000 }))
  const expected = run(entry)
  const actual = run(output)
  expect(actual).toEqual(expected)
  return actual
}

describe('automatic module compatibility', () => {
  it('publishes each object-pattern target before the next getter and default initializer', () => {
    compareModules({ 'entry.mjs': `
      export let first = 0, second = 0, rest;
      export function update(observe) {
        const seen = [];
        const source = { get a() { return 3; }, get b() { seen.push(observe()); }, c: 9 };
        ({ a: first, b: second = observe(), ...rest } = source);
        return [seen, first, second, rest];
      }
    ` }, mod => [mod.update(() => mod.first), mod.first, mod.second, mod.rest])
  })

  it('preserves assignment-expression results and nested targets', () => {
    compareModules({ 'entry.mjs': `
      export let first = 0, second = 0;
      export function update() {
        const source = [4, { value: 5 }];
        const result = ([first, { value: second }] = source);
        return [result === source, first, second];
      }
    ` }, mod => [mod.update(), mod.first, mod.second])
  })

  it('publishes the first array target before a later setter observes it', () => {
    compareModules({ 'entry.mjs': `
      export let first = 0;
      export function update(observe) {
        let seen;
        const target = { set value(value) { seen = [observe(), value]; } };
        [first, target.value] = [4, 5];
        return seen;
      }
    ` }, mod => [mod.update(() => mod.first), mod.first])
  })

  it('retains var hoisting for destructuring loop declarations that are exported later', () => {
    compareModules({ 'entry.mjs': `
      for (var [first, second] of [[1, 2], [3, 4]]) {}
      export { first, second };
      export function update() { for ([first, second] of [[5, 6]]) {} }
    ` }, mod => {
      const initial = [mod.first, mod.second];
      mod.update();
      return [initial, mod.first, mod.second];
    })
  })

  it('preserves shadowed local patterns and live re-export aliases', () => {
    compareModules({
      'state.mjs': `
        export let value = 1;
        export function update() { [value] = [4]; }
        export function shadow(value) { [value] = [9]; return value; }
      `,
      'entry.mjs': `export { value as current, update, shadow } from './state.mjs';`,
    }, mod => { mod.update(); return [mod.current, mod.shadow(0), mod.current] })
  })

  it('instantiates cyclic function declarations before evaluation and retains lexical TDZ', () => {
    expect(compareModules({
      'entry.mjs': `
        import { initial, errors, beforeVar } from './dependency.mjs';
        export function readFunction() { return 7; }
        export let lexical = 9;
        export var variable = 10;
        export class Klass {}
        export { initial, errors, beforeVar };
      `,
      'dependency.mjs': `
        import { readFunction, lexical, variable, Klass } from './entry.mjs';
        export const initial = readFunction();
        export const errors = [];
        export const beforeVar = variable === undefined;
        try { lexical; } catch (error) { errors.push(error.name); }
        try { Klass; } catch (error) { errors.push(error.name); }
      `,
    }, mod => [mod.initial, mod.errors, mod.beforeVar, mod.lexical, mod.variable])).toEqual([
      7, ['ReferenceError', 'ReferenceError'], true, 9, 10,
    ])
  })

  it('evaluates a cycle in entry-rooted depth-first order with dependencies evaluated once', () => {
    compareModules({
      'entry.mjs': `
        import './left.mjs'; import './right.mjs';
        globalThis.order.push('entry');
        export const order = globalThis.order;
      `,
      'left.mjs': `import './entry.mjs'; import './shared.mjs'; globalThis.order.push('left');`,
      'right.mjs': `import './shared.mjs'; import './left.mjs'; globalThis.order.push('right');`,
      'shared.mjs': `globalThis.order = ['shared'];`,
    }, mod => mod.order)
  })

  it('keeps cyclic namespace imports and escaped closure writes live', () => {
    compareModules({
      'entry.mjs': `
        import * as counter from './counter.mjs';
        export let value = 1;
        export function increment() { value++; }
        export function inspect() { return counter.inspect(); }
        export { counter };
      `,
      'counter.mjs': `
        import * as entry from './entry.mjs';
        export function inspect() { return entry.value; }
        export function change() { entry.increment(); }
      `,
    }, mod => {
      const before = mod.inspect();
      mod.counter.change();
      return [before, mod.inspect(), mod.value, Object.keys(mod.counter).sort()];
    })
  })

  it('resolves cyclic star exports, retaining explicit overrides and omitting ambiguity', () => {
    compareModules({
      'entry.mjs': `export * from './left.mjs'; export * from './right.mjs'; export { conflict as chosen } from './left.mjs';`,
      'left.mjs': `export * from './entry.mjs'; export const left = 1; export const conflict = 'left';`,
      'right.mjs': `export * from './entry.mjs'; export const right = 2; export const conflict = 'right';`,
    }, mod => [Object.keys(mod).sort(), mod.left, mod.right, mod.chosen])
  })

  it('supports self-imports without evaluating the module twice', () => {
    compareModules({ 'entry.mjs': `
      import { value as self } from './entry.mjs';
      export let value = 2;
      export function read() { return self; }
      export const result = read();
    ` }, mod => [mod.value, mod.result, mod.read()])
  })


  it('retains implicit module strictness for exported functions', () => {
    compareModules({ 'entry.mjs': `
      export function receiver() { return this; }
      export function callReceiver() { return receiver(); }
    ` }, mod => [mod.callReceiver() === undefined, (0, mod.receiver)() === undefined, mod.receiver.call(2) === 2])
  })


  it('preserves top-level module this in arrows and computed method keys', () => {
    compareModules({ 'entry.mjs': `
      export const top = this === undefined;
      export const arrow = () => this;
      export class Example {
        [this === undefined ? 'method' : 'other']() { return this; }
      }
    ` }, mod => {
      const instance = new mod.Example();
      return [mod.top, mod.arrow.call({}) === undefined, instance.method() === instance];
    })
  })

  it('rejects an unresolved indirect export cycle before evaluating either module', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptvm-invalid-module-cycle-'));
    directories.push(dir);
    fs.writeFileSync(path.join(dir, 'entry.mjs'), "export { missing } from './other.mjs';");
    fs.writeFileSync(path.join(dir, 'other.mjs'), "export { missing } from './entry.mjs';");
    expect(() => transform(path.join(dir, 'entry.mjs'), { format: 'esm' })).toThrow('no unambiguous export');
  })

  it('keeps CommonJS cycles outside the ESM instantiation path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scriptvm-cjs-module-cycle-'));
    directories.push(dir);
    fs.writeFileSync(path.join(dir, 'entry.cjs'), "require('./other.cjs'); module.exports = 1;");
    fs.writeFileSync(path.join(dir, 'other.cjs'), "require('./entry.cjs');");
    expect(() => transform(path.join(dir, 'entry.cjs'), { format: 'cjs' })).toThrow('Circular dependency');
  })


  it.each([false, true])('does not expose factory arguments at module scope (cycle: %s)', cyclic => {
    compareModules({
      'entry.mjs': `
        import { inspect, ordinary, arrow, nested, direct } from './dependency.mjs';
        export { inspect, ordinary, arrow, nested, direct };
      `,
      'dependency.mjs': `
        ${cyclic ? "import './entry.mjs';" : ''}
        const type = typeof arguments;
        const arrow = () => arguments;
        const nested = () => () => arguments;
        let direct;
        try { direct = arguments; } catch (error) { direct = error.name; }
        export { arrow, nested, direct };
        export function inspect() { return type; }
        export function ordinary(value) { return arguments[0]; }
      `,
    }, mod => {
      let absent, nestedAbsent;
      try { mod.arrow(); } catch (error) { absent = error.name; }
      try { mod.nested()(); } catch (error) { nestedAbsent = error.name; }
      globalThis.arguments = 7;
      const present = [mod.arrow(), mod.nested()()];
      delete globalThis.arguments;
      return [mod.inspect(), mod.direct, absent, nestedAbsent, present, mod.ordinary(8)];
    })
  })

})
