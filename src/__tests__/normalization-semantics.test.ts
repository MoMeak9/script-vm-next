import { describe, it } from 'vitest'
import { expectEquivalent } from './differential'

describe('internal compatibility helper names', () => {
  it('preserves user bindings that match generated destructuring temporary names', () => {
    expectEquivalent(`
      const _d0 = 10, _d1 = 20, _d2 = 30;
      const [first, ...rest] = new Set([1, 2, 3]);
      let value;
      const returned = ([value] = [7]);
      globalThis.__result = [_d0, _d1, _d2, first, rest, value, returned];
    `)
  })

  it('preserves user variables and parameters around lexical arrow captures', () => {
    expectEquivalent(`
      function run(_this0, _arguments1, _newTarget2, _d0) {
        return (() => [this.value, arguments[0], _this0, _arguments1, _newTarget2, _d0])();
      }
      globalThis.__result = run.call({ value: 7 }, 10, 20, 30, 40);
    `)
  })

  it('does not rename a catch binding into an existing user binding', () => {
    expectEquivalent(`
      const __catch_error_0 = 'outer', _d0 = 'temporary-like';
      let result;
      try { throw 'caught'; } catch (error) {
        result = [error, __catch_error_0, _d0];
      }
      globalThis.__result = result;
    `)
  })
})
