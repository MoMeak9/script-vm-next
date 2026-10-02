import type { ProgramArtifact } from './types'

function serializeConstant(value: unknown): string {
  if (value === undefined) return '(void 0)'
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '(0/0)'
    if (value === Infinity) return '(1/0)'
    if (value === -Infinity) return '(-1/0)'
    if (Object.is(value, -0)) return '-0'
  }
  if (typeof value === 'bigint') return `${value}n`
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return JSON.stringify(value)
  }
  throw new TypeError(`Unsupported constant pool value: ${typeof value}`)
}

/** JSON cannot preserve non-finite numbers, negative zero or undefined.
 * Emit only primitive literals/constant expressions in the generated program;
 * keep structural metadata in JSON and never interpret string constants as code.
 */
export function serializeArtifact(artifact: ProgramArtifact): string {
  const { constantPool, ...metadata } = artifact
  return `${JSON.stringify(metadata).slice(0, -1)},"constantPool":[${constantPool.map(serializeConstant).join(',')}]}`
}
