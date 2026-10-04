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
  parameterSlots: number[]
  simpleParameters: boolean
  argumentsSlot?: number
  slotNames: string[]
  slotKinds: SlotKind[]
  async: boolean
  generator: boolean
  strict: boolean
  method: boolean
  module: boolean
  length: number
  parameterEnd?: number
}

export interface ProgramArtifact {
  format: ModuleFormat
  bytecode: number[]
  constantPool: any[]
  functions: FunctionMeta[]
  entryFunctionId: number
  exportNames: string[]
  /** Generated, collision-free name for the ESM binding notification hook. */
  notifyIdentifier?: string
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
