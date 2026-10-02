import { expect, it } from 'vitest'
import { expectEquivalent } from './differential'

it('rejects unobservable logs even if the fixture catches the logger error', () => {
  expect(() => expectEquivalent(`
    try { console.log(Symbol('not cloneable')); } catch (error) {}
    globalThis.__result = 1;
  `)).toThrow('Differential fixtures must log structured-cloneable values')
})
