import type { LoweredProgram } from './ir'

export interface AllocationResult extends LoweredProgram {}

export function allocateRegisters(program: LoweredProgram): AllocationResult {
  return program
}
