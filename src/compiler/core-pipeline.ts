import type * as t from '@babel/types'
import { CompileError, compileStep } from './diagnostics'
import { emitBytecode } from './emit'
import { normalizeAst, parseSource } from './frontend'
import { lowerToIR } from './lowering'
import { packArtifact } from './pack'
import { allocateRegisters } from './regalloc'
import type { CompiledOutput, ModuleFormat, ProgramArtifact, RuntimeMode } from './types'

export interface ProgramCompileOptions {
  filename?: string
  format: ModuleFormat
  debug?: boolean
  runtime?: RuntimeMode
  exportNames?: string[]
  exportsIdentifier?: string
  notifyIdentifier?: string
  hostImports?: ProgramArtifact['hostImports']
  hostExports?: ProgramArtifact['hostExports']
}

export function resolveRuntimeMode(runtime: unknown, filename?: string): RuntimeMode | undefined {
  if (runtime === undefined) return undefined
  if (runtime !== 'auto' && runtime !== 'full') {
    throw new CompileError('runtime must be auto or full.', {
      code: 'INVALID_OPTION', stage: 'input', filename,
    })
  }
  return runtime
}

/** Shared, filesystem-free compiler pipeline used after module resolution. */
export function compileProgram(source: string | t.File, options: ProgramCompileOptions): CompiledOutput {
  const { filename, format } = options
  const parsed = typeof source === 'string'
    ? compileStep('parse', filename, () => parseSource(source, format === 'esm' ? 'module' : 'script'))
    : source
  const file = compileStep('normalize', filename, () => normalizeAst(parsed))
  const lowered = compileStep('lower', filename, () => lowerToIR(file, options.exportsIdentifier))
  const allocated = compileStep('allocate', filename, () => allocateRegisters(lowered))
  const artifact = compileStep('emit', filename, () => emitBytecode(
    allocated, format, options.exportNames ?? [], Boolean(options.debug)
  ))
  if (options.notifyIdentifier) artifact.notifyIdentifier = options.notifyIdentifier
  if (options.hostImports?.length) artifact.hostImports = options.hostImports
  if (options.hostExports?.length) artifact.hostExports = options.hostExports
  const code = compileStep('pack', filename, () => packArtifact(artifact, options.runtime))
  return { code, artifact }
}
