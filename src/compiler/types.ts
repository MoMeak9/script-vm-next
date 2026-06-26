import type { SlotKind } from './ir'

export type ModuleFormat = 'iife' | 'esm' | 'cjs'

export interface CompileOptions {
  format?: ModuleFormat | 'auto'
  bundle?: boolean
  external?: string[]
  basePath?: string
  debug?: boolean
  obfuscate?: boolean
  obfuscateOptions?: Record<string, unknown>
}

export interface FunctionMeta {
  id: number
  name: string | null
  entry: number
  end: number
  registerCount: number
  slotCount: number
  params: number
  slotNames: string[]
  slotKinds: SlotKind[]
  async: boolean
  generator: boolean
}

export interface ProgramArtifact {
  format: ModuleFormat
  bytecode: number[]
  constantPool: any[]
  functions: FunctionMeta[]
  entryFunctionId: number
  exportNames: string[]
  debugInfo?: {
    instructions: string[]
  }
}

export interface BundleResult {
  code: string
  entryExports: string[]
}

export interface CompiledOutput {
  code: string
  artifact: ProgramArtifact
}
