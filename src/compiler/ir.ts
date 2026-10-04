export type BindingRef =
  | { kind: 'slot'; depth: number; slot: number }
  | { kind: 'global'; name: string }

export type SlotKind = 'var' | 'let' | 'const' | 'param' | 'function' | 'catch'

export type IRInstruction =
  | { op: 'label'; name: string }
  | { op: 'enter_scope'; slots: number[] }
  | { op: 'leave_scope' }
  | { op: 'replace_scope'; slots: number[] }
  | { op: 'load_const'; dst: number; value: any }
  | { op: 'load_undefined'; dst: number }
  | { op: 'move'; dst: number; src: number }
  | { op: 'load_slot'; dst: number; depth: number; slot: number }
  | { op: 'init_slot'; depth: number; slot: number; src: number }
  | { op: 'store_slot'; depth: number; slot: number; src: number }
  | { op: 'load_global'; dst: number; name: string }
  | { op: 'typeof_global'; dst: number; name: string }
  | { op: 'parameter_end' }
  | { op: 'store_global'; name: string; src: number }
  | { op: 'load_this'; dst: number }
  | { op: 'load_arguments'; dst: number }
  | { op: 'get_prop'; dst: number; object: number; property: number }
  | { op: 'set_prop'; dst: number; object: number; property: number; value: number }
  | { op: 'binary'; dst: number; left: number; right: number; operator: string }
  | { op: 'unary'; dst: number; value: number; operator: string }
  | { op: 'jump'; target: string }
  | { op: 'abrupt_jump'; target: string; scopeDepth: number }
  | { op: 'jump_if_false'; condition: number; target: string }
  | { op: 'jump_if_not_nullish'; condition: number; target: string }
  | { op: 'try'; tryStart: string; catchStart: string | null; finallyStart: string | null; end: string; catchDepth: number; catchSlot: number }
  | { op: 'call'; dst: number; callee: number; thisReg: number; args: number[] }
  | { op: 'new'; dst: number; callee: number; args: number[] }
  | { op: 'await'; dst: number; src: number }
  | { op: 'yield'; dst: number; src: number; delegate: boolean }
  | { op: 'make_function'; dst: number; functionId: number }
  | { op: 'return'; src: number }
  | { op: 'throw'; src: number }
  | { op: 'array_new'; dst: number }
  | { op: 'array_push'; array: number; value: number }
  | { op: 'object_new'; dst: number }
  | { op: 'object_set'; object: number; key: number; value: number }
  | { op: 'delete_prop'; dst: number; object: number; property: number }
  | { op: 'load_new_target'; dst: number }

export interface FunctionIR {
  id: number
  name: string | null
  params: number
  slotNames: string[]
  slotKinds: SlotKind[]
  instructions: IRInstruction[]
  registerCount: number
  async: boolean
  generator: boolean
  strict: boolean
  method: boolean
  module: boolean
  length: number
}

export interface LoweredProgram {
  functions: FunctionIR[]
  entryFunctionId: number
}
