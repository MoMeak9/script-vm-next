import compile, { resolveFormat } from './compiler'
import type { CompileOptions } from './compiler/types'

export { compile, resolveFormat }
export { VERSION } from './version'
export { compileSource, CompileError } from './core'
export type { CompileOptions }
export type {
  CompileSourceOptions, SourceCompileOptions, CompileErrorCode, CompileErrorDetails, CompileStage,
  CompiledOutput, ProgramArtifact, FunctionMeta, ModuleFormat,
} from './core'

export function transform(inputPath: string, options?: CompileOptions): string {
  return compile(inputPath, null, options).code
}
