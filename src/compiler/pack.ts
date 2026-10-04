import { JS_PREAMBLE } from './constants'
import { generateRuntimeSource } from './runtime-gen'
import { serializeArtifact } from './artifact-serialization'
import { analyzeRuntimeRequirements } from './runtime-requirements'
import type { ProgramArtifact, RuntimeMode } from './types'

function wrapAsESM(invocation: string, exportNames: string[]): string {
  const names = [...new Set(exportNames)]
  const lines = names.map((_, index) => `let __vm_export_${index};`)
  lines.push('var __vm_result;')
  lines.push('function __vm_sync(value) {')
  lines.push('  if (__vm_result) {')
  for (const [index, name] of names.entries()) {
    lines.push(`    __vm_export_${index} = __vm_result[${JSON.stringify(name)}];`)
  }
  lines.push('  }', '  return value;', '}')
  lines.push(`__vm_result = ${invocation};`, '__vm_sync();')
  for (const [index, name] of names.entries()) {
    // String export names also cover reserved words and arbitrary aliases.
    lines.push(`export { __vm_export_${index} as ${JSON.stringify(name)} };`)
  }
  return lines.join('\n')
}

function wrapAsCJS(invocation: string, exportNames: string[]): string {
  const lines = [`var __vm_result = ${invocation};`]
  if (exportNames.length === 1 && exportNames[0] === 'default') {
    lines.push("module.exports = __vm_result['default'];")
  } else {
    lines.push('module.exports = __vm_result;')
  }
  return lines.join('\n')
}

export function packArtifact(artifact: ProgramArtifact, runtimeMode: RuntimeMode = 'auto'): string {
  const runtime = generateRuntimeSource(artifact, runtimeMode)
  const metadata = serializeArtifact(artifact)
  // The private bridge exists only in this VM's global lookup. A Proxy keeps
  // ordinary global reads/writes on the host, without publishing the bridge or
  // allowing two separately compiled modules to overwrite each other's hook.
  const scope = artifact.notifyIdentifier
    ? `var __vm_bridge = function(value) { return __vm_notify(value); };
__vm_bridge.Object = Object;
__vm_bridge.Proxy = Proxy;
__vm_bridge.TypeError = TypeError;
__vm_bridge.imports = [${(artifact.hostImports ?? []).map((_, index) => `__vm_import_${index}`).join(', ')}];
var __vm_hasGlobal = Reflect.has, __vm_getGlobal = Reflect.get, __vm_ReferenceError = ReferenceError;
__vm_bridge.getGlobal = function(name, allowMissing) {
  if (__vm_hasGlobal(__vm_global, name)) return __vm_getGlobal(__vm_global, name);
  if (!allowMissing) throw new __vm_ReferenceError(name + ' is not defined');
};
var __vm_scope = new Proxy(__vm_global, { get: function(target, key) {
  if (key === ${JSON.stringify(artifact.notifyIdentifier)}) return __vm_bridge;
  return __vm_getGlobal(target, key);
}, has: function(target, key) {
  return key === ${JSON.stringify(artifact.notifyIdentifier)} || __vm_hasGlobal(target, key);
} });`
    : 'var __vm_scope = __vm_global;'
  const invocation = `(function(__vm_notify){${JS_PREAMBLE}
__vm_global.require = typeof require !== 'undefined' ? require : __vm_global.require;
__vm_global.module = typeof module !== 'undefined' ? module : __vm_global.module;
__vm_global.exports = typeof exports !== 'undefined' ? exports : __vm_global.exports;
${analyzeRuntimeRequirements(artifact).needsDynamicImport ? '__vm_global.__vm_import = function(s) { return import(s) };' : ''}
${scope}
${runtime}
return __scriptvmRun(${metadata}, __vm_scope);
})(${artifact.format === 'esm' ? '__vm_sync' : 'function(value) { return value; }'})`

  if (artifact.format === 'esm') {
    const imports = (artifact.hostImports ?? []).flatMap(({ source, names }, index) => [
      `import * as __vm_import_${index} from ${JSON.stringify(source)};`,
      // Namespace property reads alone do not validate missing named exports.
      // Native import declarations preserve the link-time SyntaxError contract.
      ...names.map((name, position) => `import { ${JSON.stringify(name)} as __vm_check_${index}_${position} } from ${JSON.stringify(source)};`),
    ])
    const hostExports = artifact.hostExports ?? []
    const delegated = new Set(hostExports.map(item => item.exported))
    const forwards = hostExports.map(({ exported, source, imported, namespace }) => namespace
      ? `export * as ${JSON.stringify(exported)} from ${JSON.stringify(source)};`
      : `export { ${JSON.stringify(imported)} as ${JSON.stringify(exported)} } from ${JSON.stringify(source)};`)
    return [...imports, ...forwards, wrapAsESM(invocation, artifact.exportNames.filter(name => !delegated.has(name)))].join('\n')
  }
  if (artifact.format === 'cjs') {
    return wrapAsCJS(invocation, artifact.exportNames)
  }
  return invocation
}
