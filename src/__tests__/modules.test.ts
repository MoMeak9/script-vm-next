import { describe, expect, it } from 'vitest'
import { compileToCjsModule, compileToEsmModule } from './helpers'

describe('module bundling and wrappers', () => {
  it('bundles esm dependencies and preserves exports', async () => {
    const mod = await compileToEsmModule({
      'math.js': 'export function add(a, b) { return a + b }',
      'entry.js': "import { add } from './math.js'\nexport const value = add(3, 4)\nexport default value * 2\n",
    })

    expect(mod.value).toBe(7)
    expect(mod.default).toBe(14)
  })

  it('bundles cjs dependencies and returns module.exports shape', () => {
    const mod = compileToCjsModule({
      'helper.cjs': 'exports.double = function(value) { return value * 2 }',
      'entry.cjs': "var helper = require('./helper.cjs')\nexports.answer = helper.double(21)\n",
    })

    expect(mod.answer).toBe(42)
  })
})
