import traverseModule from '@babel/traverse'
import type * as t from '@babel/types'
import { compileProgram, resolveRuntimeMode } from './compiler/core-pipeline'
import { CompileError, compileStep } from './compiler/diagnostics'
import { parseSource } from './compiler/frontend'
import type { CompiledOutput, RuntimeMode } from './compiler/types'

export { CompileError } from './compiler/diagnostics'
export type { CompileErrorCode, CompileErrorDetails, CompileStage } from './compiler/diagnostics'
export type { CompiledOutput, ProgramArtifact, FunctionMeta, ModuleFormat, RuntimeMode, RuntimeRequirements } from './compiler/types'

const traverse: typeof traverseModule = typeof traverseModule === 'function'
  ? traverseModule
  : (traverseModule as unknown as { default: typeof traverseModule }).default

export interface CompileSourceOptions {
  /** Label used in diagnostics. No file is read or written. */
  filename?: string
  debug?: boolean
  /** Assemble the required interpreter by default; use full for diagnostics. */
  runtime?: RuntimeMode
  /** The source API accepts a standalone script and emits an IIFE. */
  format?: 'iife'
}

/** Alias matching the source-first API naming convention. */
export type SourceCompileOptions = CompileSourceOptions

function rejectModules(file: t.File, filename: string): void {
  const reject = (node: t.Node, feature: string): never => {
    throw new CompileError(
      `${feature} is not supported by compileSource; use the Node file API for modules.`,
      {
        code: 'UNSUPPORTED_MODULE', stage: 'validate', filename,
        line: node.loc?.start.line,
        column: typeof node.loc?.start.column === 'number' ? node.loc.start.column + 1 : undefined,
      }
    )
  }

  traverse(file, {
    ImportDeclaration(path) { reject(path.node, 'Static import') },
    ExportNamedDeclaration(path) { reject(path.node, 'Export') },
    ExportDefaultDeclaration(path) { reject(path.node, 'Export') },
    ExportAllDeclaration(path) { reject(path.node, 'Re-export') },
    Import(path) { reject(path.node, 'Dynamic import') },
    MetaProperty(path) {
      if (path.node.meta.name === 'import') reject(path.node, 'import.meta')
    },
    ReferencedIdentifier(path) {
      const name = path.node.name
      if (['require', 'module', 'exports'].includes(name) && !path.scope.getBinding(name)) {
        reject(path.node, `CommonJS global '${name}'`)
      }
    },
  })
}

/**
 * Compile a single JavaScript script without filesystem access or code execution.
 * Module syntax and unbound CommonJS globals are rejected. The emitted IIFE uses
 * its execution host's globals; it is not a security sandbox.
 */
export function compileSource(source: string, options: CompileSourceOptions = {}): CompiledOutput {
  if (typeof source !== 'string') {
    throw new CompileError('Source must be a string.', { code: 'INVALID_INPUT', stage: 'input' })
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new CompileError('Options must be an object.', { code: 'INVALID_OPTION', stage: 'input' })
  }
  if (options.filename !== undefined && typeof options.filename !== 'string') {
    throw new CompileError('filename must be a string.', { code: 'INVALID_OPTION', stage: 'input' })
  }
  const filename = options.filename ?? 'source.js'
  const runtime = resolveRuntimeMode(options.runtime, filename)
  if (options.format !== undefined && options.format !== 'iife') {
    throw new CompileError('compileSource only supports the iife format.', {
      code: 'INVALID_FORMAT', stage: 'input', filename,
    })
  }
  if (options.debug !== undefined && typeof options.debug !== 'boolean') {
    throw new CompileError('debug must be a boolean.', { code: 'INVALID_OPTION', stage: 'input', filename })
  }
  const file = compileStep('parse', filename, () => parseSource(source, 'unambiguous'))
  compileStep('validate', filename, () => rejectModules(file, filename))
  // Unambiguous parsing identifies module constructs for useful diagnostics;
  // still enforce script grammar (for example, reject top-level await).
  const script = file.program.sourceType === 'module'
    ? compileStep('parse', filename, () => parseSource(source, 'script'))
    : file
  return compileProgram(script, { filename, format: 'iife', debug: options.debug, runtime })
}
