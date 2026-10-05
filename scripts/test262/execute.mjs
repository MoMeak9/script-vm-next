import vm from 'node:vm'

function errorText(error) {
  return `${error?.name ?? 'Error'}: ${error?.message ?? error}`
}

export function executeVariant({ source, filename, metadata, mode, harness, compile, runtime = 'auto', timeoutMs = 1000 }) {
  const input = mode === 'strict' ? `"use strict";\n${source}` : source
  const negative = metadata.negative
  const parseNegative = negative && ['parse', 'early'].includes(negative.phase)
  // The oracle checks that vendored fixtures/harness and the host are usable.
  // Its result does not substitute for running the emitted VM program.
  for (const engine of ['native', 'vm']) {
    let code = input
    let caught
    try {
      code = engine === 'vm' ? compile(input, { filename, runtime }).code : new vm.Script(input, { filename })
    } catch (error) { caught = error }
    if (parseNegative) {
      const correct = engine === 'native'
        ? caught instanceof SyntaxError && negative.type === 'SyntaxError'
        : caught?.code === 'SYNTAX_ERROR' && caught?.stage === 'parse' && caught?.cause?.name === negative.type
      if (!correct) return { status: 'fail', engine, detail: caught ? `Wrong parse failure: ${errorText(caught)}` : 'Expected parse failure; compilation succeeded' }
      continue
    }
    if (caught) return { status: 'fail', engine, detail: `Unexpected compile failure: ${errorText(caught)}` }
    if (engine === 'vm') {
      try { code = new vm.Script(code, { filename: `${filename}.compiled.js` }) } catch (error) {
        return { status: 'fail', engine, detail: `Invalid emitted JavaScript: ${errorText(error)}` }
      }
    }
    const context = vm.createContext({})
    try {
      for (const file of harness) new vm.Script(file.source, { filename: file.filename }).runInContext(context, { timeout: timeoutMs })
    } catch (error) {
      return { status: 'fail', engine, detail: `Harness failed: ${errorText(error)}` }
    }
    let expected
    if (negative?.phase === 'runtime') {
      try { expected = vm.runInContext(negative.type, context, { timeout: timeoutMs }) } catch (error) {
        return { status: 'fail', engine, detail: `Invalid runtime-negative constructor: ${errorText(error)}` }
      }
      if (typeof expected !== 'function') return { status: 'fail', engine, detail: 'Runtime-negative constructor is not a function' }
    }
    caught = undefined
    try {
      code.runInContext(context, { timeout: timeoutMs })
    } catch (error) { caught = error }
    if (caught?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') return { status: 'fail', engine, timeout: true, detail: 'Execution timed out' }
    if (negative?.phase === 'runtime') {
      if (!(caught instanceof expected) || caught.constructor !== expected) {
        return { status: 'fail', engine, detail: `Expected runtime ${negative.type}; ${caught ? errorText(caught) : 'execution succeeded'}` }
      }
    } else if (caught) return { status: 'fail', engine, detail: `Unexpected runtime failure: ${errorText(caught)}` }
  }
  return { status: 'pass' }
}
