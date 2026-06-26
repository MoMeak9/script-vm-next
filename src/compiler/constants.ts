export const ROOT_THIS = '@script-vm-next'
export const ARGUMENTS_NAME = 'arguments'

export const JS_PREAMBLE = `
var __vm_global = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : {});
`
