import * as fs from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { compile, compileSource as nodeCompileSource, transform } from '../index'
import { compileSource, CompileError } from '../core'
import { makeTempDir, runIifeCode, writeTempFile } from './helpers'

function diagnostic(source: string): CompileError {
  try {
    compileSource(source, { filename: 'editor.js' })
  } catch (error) {
    expect(error).toBeInstanceOf(CompileError)
    return error as CompileError
  }
  throw new Error('Expected compilation to fail')
}

describe('compileSource', () => {
  it('compiles a source string synchronously through both public entrypoints', () => {
    expect(nodeCompileSource).toBe(compileSource)
    const output = compileSource('var double = n => n * 2; __result = double(21);')
    expect(output.artifact.format).toBe('iife')
    expect(output.artifact.bytecode.length).toBeGreaterThan(0)
    expect(runIifeCode(output.code).__result).toBe(42)
  })

  it('does not execute input while compiling', () => {
    const key = '__scriptVmCompileSourceExecuted'
    delete (globalThis as any)[key]
    compileSource(`globalThis.${key} = true; throw new Error('must not run');`)
    expect((globalThis as any)[key]).toBeUndefined()
  })

  it('adds debug instructions only on request', () => {
    expect(compileSource('var n = 1;').artifact.debugInfo).toBeUndefined()
    expect(compileSource('var n = 1;', { debug: true }).artifact.debugInfo?.instructions.length).toBeGreaterThan(0)
  })

  it('accepts empty scripts and hashbangs', () => {
    expect(compileSource('').artifact.functions).toHaveLength(1)
    expect(runIifeCode(compileSource('#!/usr/bin/env node\n__result = 7;').code).__result).toBe(7)
  })

  it('preserves script parsing and does not treat module words in strings as imports', () => {
    const output = compileSource('/* import x from "x" */ var words = "export require module"; __result = words;')
    expect(runIifeCode(output.code).__result).toBe('export require module')
  })

  it('allows locally bound CommonJS names in ordinary scripts', () => {
    const source = `
      function calculate(require, module, exports) { return require(module) + exports; }
      __result = calculate(x => x * 2, 20, 2);
    `
    expect(runIifeCode(compileSource(source).code).__result).toBe(42)
  })

  it.each([
    'import x from "./dep.js";',
    'export const x = 1;',
    'export default 1;',
    'export * from "./dep.js";',
    'const dep = require("./dep.js");',
    'module.exports = 1;',
    'exports.x = 1;',
    'const load = require;',
    'import("./dep.js");',
    'console.log(import.meta.url);',
  ])('rejects unsupported modules with a source position: %s', source => {
    expect(diagnostic(source)).toMatchObject({
      code: 'UNSUPPORTED_MODULE', stage: 'validate', filename: 'editor.js', line: 1,
    })
    expect(diagnostic(source).column).toBeGreaterThan(0)
  })

  it('provides one-based syntax error locations and serializable diagnostics', () => {
    const error = diagnostic('var valid = 1;\nconst broken = ;')
    expect(error).toMatchObject({ code: 'SYNTAX_ERROR', stage: 'parse', filename: 'editor.js', line: 2, column: 16 })
    expect(error.cause).toBeInstanceOf(Error)
    expect(JSON.parse(JSON.stringify(error))).toMatchObject({
      name: 'CompileError', message: 'Unexpected token', code: 'SYNTAX_ERROR', line: 2, column: 16,
    })
    expect(error.toJSON()).not.toHaveProperty('cause')
  })

  it.each([
    [42, {}, 'INVALID_INPUT'],
    ['var n = 1;', null, 'INVALID_OPTION'],
    ['var n = 1;', [], 'INVALID_OPTION'],
    ['var n = 1;', { filename: 1 }, 'INVALID_OPTION'],
    ['var n = 1;', { debug: 'true' }, 'INVALID_OPTION'],
    ['var n = 1;', { format: 'esm' }, 'INVALID_FORMAT'],
    ['var n = 1;', { format: 'unknown' }, 'INVALID_FORMAT'],
  ])('rejects invalid API input %#', (source, options, code) => {
    try {
      compileSource(source as string, options as any)
      throw new Error('Expected invalid input to fail')
    } catch (error) {
      expect(error).toMatchObject({ name: 'CompileError', code, stage: 'input' })
    }
  })

  it('rejects top-level await in the standalone script API', () => {
    expect(diagnostic('await Promise.resolve(1);')).toMatchObject({
      code: 'SYNTAX_ERROR', stage: 'parse', filename: 'editor.js', line: 1,
    })
  })

  it('labels unsupported lowering with its compilation stage', () => {
    expect(diagnostic('with ({}) {}')).toMatchObject({
      code: 'COMPILATION_ERROR', stage: 'lower', filename: 'editor.js',
    })
  })
})

describe('Node file API compatibility', () => {
  it('shares the source pipeline while preserving default paths and no-output transform', () => {
    const dir = makeTempDir('script-vm-next-core-node-')
    const source = '__result = 6 * 7;'
    const input = writeTempFile(dir, 'input.js', source)
    const output = compile(input, undefined, { format: 'iife' })
    expect(output.code).toBe(compileSource(source).code)
    expect(fs.readFileSync(path.join(dir, 'input.vm.js'), 'utf8')).toBe(output.code)
    fs.unlinkSync(path.join(dir, 'input.vm.js'))
    expect(transform(input, { format: 'iife' })).toBe(output.code)
    expect(fs.existsSync(path.join(dir, 'input.vm.js'))).toBe(false)
  })

  it('wraps missing file errors with structured diagnostics', () => {
    const input = path.join(makeTempDir('script-vm-next-core-missing-'), 'missing.js')
    expect(() => compile(input, null)).toThrow(CompileError)
    try {
      compile(input, null)
    } catch (error) {
      expect(error).toMatchObject({ code: 'IO_ERROR', stage: 'read', filename: input })
    }
  })
})
