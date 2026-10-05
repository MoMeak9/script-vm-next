import type { ProgramArtifact } from '../../src/compiler/types'

export interface CompileResult {
  code: string
  artifact: ProgramArtifact
  durationMs: number
  stats: {
    bytecodeWords: number
    functionCount: number
    runtime?: {
      instructionCount: number
      executionModes: Array<'sync' | 'async' | 'generator' | 'async-generator'>
    }
  }
}

export interface CompileFailure extends Error {
  code?: string
  filename?: string
  line?: number
  column?: number
  stage?: string
}

export interface Compiler {
  compile(source: string, debug?: boolean): Promise<CompileResult>
  cancel(): void
  dispose(): void
}

const MAX_SOURCE_BYTES = 64 * 1024
const COMPILE_TIMEOUT_MS = 15_000
const MAX_GENERATED_LENGTH = 8 * 1024 * 1024
const MAX_LOGS = 200
const MAX_LOG_LENGTH = 4_000

/** Compilation has its own terminable worker; Babel never blocks the editor. */
export function createCompiler(): Compiler {
  let worker: Worker | undefined
  let pending: {
    id: number
    resolve(value: CompileResult): void
    reject(reason: Error): void
    timer: ReturnType<typeof setTimeout>
  } | undefined
  let nextId = 0
  let disposed = false

  function reset(reason: Error): void {
    worker?.terminate()
    worker = undefined
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(reason)
      pending = undefined
    }
  }

  function getWorker(): Worker {
    if (!worker) {
      worker = new Worker(new URL('./compiler.worker.ts', import.meta.url), { type: 'module' })
      worker.addEventListener('message', (event: MessageEvent) => {
        if (!pending || event.data?.id !== pending.id) return
        const current = pending
        pending = undefined
        clearTimeout(current.timer)
        if (event.data.error) {
          current.reject(Object.assign(new Error(event.data.error.message), event.data.error))
        } else {
          current.resolve(event.data.result as CompileResult)
        }
      })
      worker.addEventListener('error', (event) => {
        event.preventDefault()
        reset(new Error(event.message || 'The compiler worker could not start.'))
      })
      worker.addEventListener('messageerror', () => reset(new Error('Invalid compiler worker response.')))
    }
    return worker
  }

  return {
    compile(source, debug = false) {
      if (disposed) return Promise.reject(new Error('The compiler has been disposed.'))
      if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) {
        return Promise.reject(new Error('Source exceeds the 64 KiB playground limit.'))
      }
      if (pending) reset(new Error('Compilation cancelled.'))
      return new Promise((resolve, reject) => {
        try {
          const active = getWorker()
          const id = ++nextId
          const timer = setTimeout(() => reset(new Error('Compilation timed out after 15 seconds.')), COMPILE_TIMEOUT_MS)
          pending = { id, resolve, reject, timer }
          active.postMessage({ id, source, debug })
        } catch (error) {
          reset(error instanceof Error ? error : new Error(String(error)))
          reject(error)
        }
      })
    },
    cancel: () => reset(new Error('Compilation cancelled.')),
    dispose() {
      disposed = true
      reset(new Error('The compiler has been disposed.'))
    },
  }
}

export type RunStatus = 'running' | 'completed' | 'stopped' | 'timeout'
export interface LogEntry {
  level: 'log' | 'info' | 'warn' | 'error'
  text: string
}
export interface RunOptions {
  onLog(entry: LogEntry): void
  onStatus(status: RunStatus): void
  onError(error: string): void
  timeoutMs?: number
}

/**
 * The worker runs inside a fresh opaque-origin sandbox, with its own network-denying
 * CSP. Worker termination alone is insufficient to isolate same-origin storage.
 */
export function runCode(code: string, options: RunOptions): { stop(): void } {
  if (code.length > MAX_GENERATED_LENGTH) {
    options.onError('Generated code exceeds the 8 MiB playground limit.')
    return { stop() {} }
  }

  const token = crypto.randomUUID()
  const iframe = document.createElement('iframe')
  iframe.sandbox.add('allow-scripts')
  iframe.title = 'Isolated JavaScript execution'
  iframe.hidden = true
  iframe.src = new URL(`${import.meta.env.BASE_URL}runner.html`, window.location.href).href
  let finished = false
  let logCount = 0
  let timer: ReturnType<typeof setTimeout>
  const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? 3_000, 10_000))

  function cleanup(): void {
    finished = true
    clearTimeout(timer)
    window.removeEventListener('message', onMessage)
    iframe.remove()
  }

  function end(status: RunStatus): void {
    if (finished) return
    cleanup()
    options.onStatus(status)
  }

  function fail(message: string): void {
    if (finished) return
    cleanup()
    options.onError(message)
  }

  function onMessage(event: MessageEvent): void {
    if (finished || event.source !== iframe.contentWindow || event.origin !== 'null') return
    const data = event.data
    if (!data || data.token !== token) return
    switch (data.type) {
      case 'started':
        clearTimeout(timer)
        timer = setTimeout(() => end('timeout'), timeoutMs)
        break
      case 'log':
        if (typeof data.text !== 'string' || !['log', 'info', 'warn', 'error'].includes(data.level)) return
        if (logCount++ < MAX_LOGS + 1) {
          options.onLog({ level: data.level, text: data.text.slice(0, MAX_LOG_LENGTH) })
        }
        break
      case 'completed':
        end('completed')
        break
      case 'error':
        fail(typeof data.message === 'string' ? data.message.slice(0, MAX_LOG_LENGTH) : 'Execution failed.')
        break
    }
  }

  iframe.addEventListener('load', () => {
    if (!finished) iframe.contentWindow?.postMessage({ type: 'run', token, code }, '*')
  }, { once: true })
  iframe.addEventListener('error', () => fail('The isolated runner could not load.'), { once: true })
  window.addEventListener('message', onMessage)
  timer = setTimeout(() => fail('The isolated runner could not start within 10 seconds.'), 10_000)
  document.body.append(iframe)
  options.onStatus('running')
  return { stop: () => end('stopped') }
}
