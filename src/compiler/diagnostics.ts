/** Compiler phases reported by the Node and browser APIs. */
export type CompileStage =
  | 'input' | 'read' | 'parse' | 'validate' | 'bundle'
  | 'normalize' | 'lower' | 'allocate' | 'emit' | 'pack' | 'write'

export type CompileErrorCode =
  | 'INVALID_INPUT' | 'INVALID_OPTION' | 'INVALID_FORMAT' | 'SYNTAX_ERROR'
  | 'UNSUPPORTED_MODULE' | 'UNSUPPORTED_FEATURE' | 'IO_ERROR' | 'BUNDLE_ERROR'
  | 'COMPILATION_ERROR'

export interface CompileErrorDetails {
  code: CompileErrorCode
  stage: CompileStage
  filename?: string
  /** One-based source line, when a source location is available. */
  line?: number
  /** One-based source column, when a source location is available. */
  column?: number
  cause?: unknown
}

/** A serializable diagnostic; source locations use one-based lines and columns. */
export class CompileError extends Error {
  readonly code: CompileErrorCode
  readonly stage: CompileStage
  readonly filename?: string
  readonly line?: number
  readonly column?: number
  readonly cause?: unknown

  constructor(message: string, details: CompileErrorDetails) {
    super(message)
    this.name = 'CompileError'
    this.code = details.code
    this.stage = details.stage
    this.filename = details.filename
    this.line = details.line
    this.column = details.column
    this.cause = details.cause
  }

  toJSON(): Omit<CompileErrorDetails, 'cause'> & { name: string; message: string } {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      stage: this.stage,
      filename: this.filename,
      line: this.line,
      column: this.column,
    }
  }
}

/** Attach phase information without discarding the underlying error. */
export function compileStep<T>(stage: CompileStage, filename: string | undefined, action: () => T): T {
  try {
    return action()
  } catch (error) {
    if (error instanceof CompileError) throw error
    const source = error as { message?: string; loc?: { line?: number; column?: number } }
    const code = stage === 'parse' ? 'SYNTAX_ERROR'
      : stage === 'read' || stage === 'write' ? 'IO_ERROR'
      : stage === 'bundle' ? 'BUNDLE_ERROR'
      : 'COMPILATION_ERROR'
    throw new CompileError((source?.message ?? String(error)).replace(/ \(\d+:\d+\)$/, ''), {
      code,
      stage,
      filename,
      line: source?.loc?.line,
      column: typeof source?.loc?.column === 'number' ? source.loc.column + 1 : undefined,
      cause: error,
    })
  }
}
