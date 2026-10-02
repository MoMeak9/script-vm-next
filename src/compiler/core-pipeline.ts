import type * as t from '@babel/types'
import { compileStep } from './diagnostics'
import { emitBytecode } from './emit'
import { normalizeAst, parseSource } from './frontend'
import { lowerToIR } from './lowering'
import { packArtifact } from './pack'
import { allocateRegisters } from './regalloc'
import type { CompiledOutput, ModuleFormat } from './types'

export interface ProgramCompileOptions {
  filename?: string
  format: ModuleFormat
  debug?: boolean
  exportNames?: string[]
  exportsIdentifier?: string
  notifyIdentifier?: string
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
  const code = compileStep('pack', filename, () => packArtifact(artifact))
  return { code, artifact }
}
