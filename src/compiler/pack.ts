import { JS_PREAMBLE } from './constants'
import { generateRuntimeSource } from './runtime-gen'
import type { ProgramArtifact } from './types'

function wrapAsESM(invocation: string, exportNames: string[]): string {
  const lines = [`var __vm_result = ${invocation};`]
  if (exportNames.includes('default')) {
    lines.push("export default __vm_result['default'];")
  }
  for (const name of exportNames.filter((item) => item !== 'default')) {
    lines.push(`export var ${name} = __vm_result[${JSON.stringify(name)}];`)
  }
  return lines.join('\n')
}

function wrapAsCJS(invocation: string, exportNames: string[]): string {
  const lines = [`var __vm_result = ${invocation};`]
  if (exportNames.length === 1 && exportNames[0] === 'default') {
    lines.push("module.exports = __vm_result['default'];")
  } else if (exportNames.length > 0) {
    lines.push('module.exports = __vm_result;')
  } else {
    lines.push('module.exports = __vm_result;')
  }
  return lines.join('\n')
}

export function packArtifact(artifact: ProgramArtifact): string {
  const runtime = generateRuntimeSource()
  const metadata = JSON.stringify(artifact)
  const invocation = `(function(){${JS_PREAMBLE}
__vm_global.require = typeof require !== 'undefined' ? require : __vm_global.require;
__vm_global.module = typeof module !== 'undefined' ? module : __vm_global.module;
__vm_global.exports = typeof exports !== 'undefined' ? exports : __vm_global.exports;
__vm_global.__vm_import = function(s) { return import(s) };
${runtime}
return __scriptvmRun(${metadata}, __vm_global);
})()`

  if (artifact.format === 'esm') {
    return wrapAsESM(invocation, artifact.exportNames)
  }
  if (artifact.format === 'cjs') {
    return wrapAsCJS(invocation, artifact.exportNames)
  }
  return invocation
}
