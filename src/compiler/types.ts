import type { SlotKind } from './ir'
import type { OpcodeName } from '../runtime/opcodes'

export type ModuleFormat = 'iife' | 'esm' | 'cjs'
export type RuntimeMode = 'auto' | 'full'

/** Capabilities observed in emitted bytecode, including every nested function. */
export interface RuntimeRequirements {
  version: 1
  opcodes: OpcodeName[]
  binaryOperators: string[]
  unaryOperators: string[]
  intrinsics: string[]
  functionKinds: Array<'sync' | 'async' | 'generator' | 'async-generator'>
  needsArguments: boolean
  needsDynamicImport: boolean
}

export interface CompileOptions {
  format?: ModuleFormat | 'auto'
  /** Assemble only required runtime capabilities by default. */
  runtime?: RuntimeMode
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
  /** Informational manifest; packing recomputes it from validated bytecode. */
  runtimeRequirements?: RuntimeRequirements
  /** Generated, collision-free name for the ESM binding notification hook. */
  notifyIdentifier?: string
  /** Native namespace imports for host external dependencies in ESM output. */
  hostImports?: Array<{ source: string; names: string[] }>
  /** Entry exports delegated directly to native host bindings. */
  hostExports?: Array<{ exported: string; source: string; imported: string; namespace?: boolean }>
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
