import compile, { resolveFormat } from './compiler'
import type { CompileOptions } from './compiler/types'

export { compile, resolveFormat }
export type { CompileOptions }

export function transform(inputPath: string, options?: CompileOptions): string {
  return compile(inputPath, null, options).code
}
