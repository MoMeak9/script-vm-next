import type { LoweredProgram } from './ir'

export type AllocationResult = LoweredProgram

export function allocateRegisters(program: LoweredProgram): AllocationResult {
  return program
}
