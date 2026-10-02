import * as vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { serializeArtifact } from '../compiler/artifact-serialization'
import type { ProgramArtifact } from '../compiler/types'
import { expectEquivalent } from './differential'

describe('constant preservation', () => {
  it.each([
    'globalThis.__result = [1e400, null, -1e400, 0, -0]',
    'globalThis.__result = [null, 1e400, 2e400, -1e400]',
    'globalThis.__result = [1 / -0, 1 / 0, Object.is(-0, 0)]',
    'globalThis.__result = ["Infinity", "NaN", "undefined", "-0", "</script>"]',
  ])('matches native execution: %s', expectEquivalent)

  it('serializes primitive constants without loss or identifier lookup', () => {
    const constantPool = [undefined, null, NaN, Infinity, -Infinity, -0, 0, 123n, true, '"}; throw 1; //']
    const artifact: ProgramArtifact = {
      format: 'iife', bytecode: [], constantPool, functions: [], entryFunctionId: 0, exportNames: [],
    }
    const restored = vm.runInNewContext(`(${serializeArtifact(artifact)})`, { Infinity: 1, NaN: 2, undefined: 3 })
    expect(Array.from(restored.constantPool)).toStrictEqual(constantPool)
  })
})
