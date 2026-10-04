import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as vm from 'node:vm'
import { expect } from 'vitest'
import { transform } from '../index'

/** Run synchronous fixtures in fresh native realms with an execution deadline.
 * Fixtures expose structured-cloneable results through globalThis.__result and console.
 * Compare exception names, not engine-specific messages or stack traces.
 */
function observe(source: string) {
  const logs: unknown[][] = []
  let observationError: Error | undefined
  const context = vm.createContext({
    console: Object.fromEntries(
      ['log', 'info', 'warn', 'error', 'debug'].map((level) => [
        level,
        (...args: unknown[]) => {
          try {
            logs.push([level, ...structuredClone(args)])
          } catch {
            observationError = new Error('Differential fixtures must log structured-cloneable values')
            throw observationError
          }
        },
      ])
    ),
  })
  let error: string | undefined
  try {
    vm.runInContext(source, context, { timeout: 1000 })
  } catch (cause) {
    if ((cause as { code?: string })?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw cause
    error = cause && typeof cause === 'object' && 'name' in cause
      ? String(cause.name)
      : `Thrown:${typeof cause}:${String(cause)}`
  }
  // A logger failure belongs to the harness, not to the program being compared.
  // Otherwise both executions could stop early with DataCloneError and falsely pass.
  if (observationError) throw observationError
  return { result: structuredClone(context.__result), logs, error }
}

export function expectEquivalent(source: string): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'script-vm-differential-'))
  try {
    const input = path.join(directory, 'input.js')
    fs.writeFileSync(input, source)
    const code = transform(input, { format: 'iife' })
    expect(observe(code)).toStrictEqual(observe(source))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
