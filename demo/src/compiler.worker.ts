import { compileSource } from '../../src/core'

const MAX_SOURCE_BYTES = 64 * 1024

self.addEventListener('message', (event: MessageEvent) => {
  const { id, source, debug } = event.data ?? {}
  if (typeof id !== 'number' || typeof source !== 'string') return
  const started = performance.now()

  try {
    if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
      throw new Error('Source exceeds the 64 KiB playground limit.')
    }
    const result = compileSource(source, {
      filename: 'playground.js',
      format: 'iife',
      debug: Boolean(debug),
    })
    self.postMessage({
      id,
      result: {
        ...result,
        durationMs: performance.now() - started,
        stats: {
          bytecodeWords: result.artifact.bytecode.length,
          functionCount: result.artifact.functions.length,
        },
      },
    })
  } catch (error) {
    const detail = error as Error & {
      code?: string
      filename?: string
      line?: number
      column?: number
      stage?: string
    }
    self.postMessage({
      id,
      error: {
        message: detail.message ?? String(error),
        code: detail.code,
        filename: detail.filename,
        line: detail.line,
        column: detail.column,
        stage: detail.stage,
      },
    })
  }
})
