import { BINARY_OPS, OPCODES, UNARY_OPS } from '../runtime/opcodes'

export function generateRuntimeSource(): string {
  return `
function __scriptvmRun(metadata, globalObject) {
  var OPCODES = ${JSON.stringify(OPCODES)};
  var BINARY_OPS = ${JSON.stringify(BINARY_OPS)};
  var UNARY_OPS = ${JSON.stringify(UNARY_OPS)};
  var NORMAL = 'normal';
  var RETURN = 'return';
  var THROW = 'throw';

  // Frontend-generated helpers use names that cannot occur as source bindings.
  // Capture their intrinsics outside interpreted lexical scopes; a parameter
  // named Object or WeakMap must not change private field operator semantics.
  var intrinsicObject = Object;
  var intrinsicWeakMap = WeakMap;
  var intrinsicWeakSet = WeakSet;
  var intrinsicTypeError = TypeError;
  function readGlobal(name) {
    switch (name) {
      case '@script-vm/intrinsic/Object': return intrinsicObject;
      case '@script-vm/intrinsic/WeakMap': return intrinsicWeakMap;
      case '@script-vm/intrinsic/WeakSet': return intrinsicWeakSet;
      case '@script-vm/intrinsic/TypeError': return intrinsicTypeError;
      default: return globalObject[name];
    }
  }

  function binary(op, left, right) {
    switch (op) {
      case BINARY_OPS['+']: return left + right;
      case BINARY_OPS['-']: return left - right;
      case BINARY_OPS['*']: return left * right;
      case BINARY_OPS['/']: return left / right;
      case BINARY_OPS['%']: return left % right;
      case BINARY_OPS['==']: return left == right;
      case BINARY_OPS['===']: return left === right;
      case BINARY_OPS['!=']: return left != right;
      case BINARY_OPS['!==']: return left !== right;
      case BINARY_OPS['>']: return left > right;
      case BINARY_OPS['>=']: return left >= right;
      case BINARY_OPS['<']: return left < right;
      case BINARY_OPS['<=']: return left <= right;
      case BINARY_OPS['&&']: return left && right;
      case BINARY_OPS['||']: return left || right;
      case BINARY_OPS['**']: return left ** right;
      case BINARY_OPS['<<']: return left << right;
      case BINARY_OPS['>>']: return left >> right;
      case BINARY_OPS['>>>']: return left >>> right;
      case BINARY_OPS['&']: return left & right;
      case BINARY_OPS['|']: return left | right;
      case BINARY_OPS['^']: return left ^ right;
      case BINARY_OPS['instanceof']: return left instanceof right;
      case BINARY_OPS['in']: return left in right;
      default: throw new Error('Unsupported binary operator code: ' + op);
    }
  }

  function unary(op, value) {
    switch (op) {
      case UNARY_OPS['!']: return !value;
      case UNARY_OPS['-']: return -value;
      case UNARY_OPS['+']: return +value;
      case UNARY_OPS['typeof']: return typeof value;
      case UNARY_OPS['void']: return void value;
      // Postfix update returns ToNumeric(value), including object-to-BigInt
      // coercion. Only this local parameter is modified; user coercion runs once.
      case UNARY_OPS['to_numeric']: return value++;
      case UNARY_OPS['++']: return ++value;
      case UNARY_OPS['--']: return --value;
      default: throw new Error('Unsupported unary operator code: ' + op);
    }
  }

  function resolveEnv(env, depth) {
    var current = env
    while (depth > 0) {
      current = current.parent
      depth -= 1
    }
    return current
  }

  function completion(type, value) {
    return { type: type, value: value }
  }

  function assertInitialized(targetEnv, slot) {
    if (!targetEnv.states[slot]) {
      throw new ReferenceError("Cannot access '" + targetEnv.slotNames[slot] + "' before initialization")
    }
  }

  function readSlot(targetEnv, slot) {
    assertInitialized(targetEnv, slot)
    return targetEnv.values[slot]
  }

  function writeSlot(targetEnv, slot, value, isInit) {
    var kind = targetEnv.slotKinds[slot]
    if (isInit) {
      targetEnv.values[slot] = value
      targetEnv.states[slot] = 1
      return value
    }
    assertInitialized(targetEnv, slot)
    if (kind === 'const') {
      throw new TypeError("Assignment to constant variable '" + targetEnv.slotNames[slot] + "'")
    }
    targetEnv.values[slot] = value
    return value
  }

  function createEnv(meta, parentEnv, thisValue, args) {
    var env = {
      values: new Array(meta.slotCount),
      states: new Array(meta.slotCount),
      slotKinds: meta.slotKinds,
      slotNames: meta.slotNames,
      parent: parentEnv,
      thisValue: thisValue,
      args: args,
    }
    for (var i = 0; i < meta.slotCount; i++) {
      var kind = meta.slotKinds[i]
      if (kind === 'var' || kind === 'function') {
        env.values[i] = undefined
        env.states[i] = 1
      } else {
        env.states[i] = 0
      }
    }
    for (var i = 0; i < meta.params; i++) {
      env.values[i] = args[i]
      env.states[i] = 1
    }
    return env
  }

  function createScopeEnv(meta, parentEnv, thisValue, args, slots, sourceEnv) {
    var env = {
      values: new Array(meta.slotCount),
      states: new Array(meta.slotCount),
      slotKinds: meta.slotKinds,
      slotNames: meta.slotNames,
      parent: parentEnv,
      thisValue: thisValue,
      args: args,
    }
    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i]
      if (sourceEnv && sourceEnv.states[slot]) {
        env.values[slot] = sourceEnv.values[slot]
        env.states[slot] = sourceEnv.states[slot]
      } else {
        env.states[slot] = 0
      }
    }
    return env
  }

  function createClosure(functionId, parentEnv) {
    var meta = metadata.functions[functionId]
    var closure
    if (meta.async && meta.generator) {
      closure = async function*() {
        return yield* executeAsyncGenerator(functionId, parentEnv, this, Array.prototype.slice.call(arguments), new.target)
      }
    } else if (meta.async) {
      closure = async function() {
        return await executeAsync(functionId, parentEnv, this, Array.prototype.slice.call(arguments), new.target)
      }
    } else if (meta.generator) {
      closure = function*() {
        return yield* executeGenerator(functionId, parentEnv, this, Array.prototype.slice.call(arguments), new.target)
      }
    } else {
      closure = function() {
        return executeSync(functionId, parentEnv, this, Array.prototype.slice.call(arguments), new.target)
      }
    }
    Object.defineProperty(closure, 'name', {
      value: meta.name === null ? '' : meta.name,
      configurable: true,
      writable: false,
      enumerable: false
    })
    return closure
  }

  function executeSync(functionId, parentEnv, thisValue, args, newTarget) {
    var meta = metadata.functions[functionId]
    var env = createEnv(meta, parentEnv, thisValue, args)
    var regs = new Array(meta.registerCount)
    var code = metadata.bytecode
    function run(start, end) {
      var pc = start
      while (pc < end) {
        var op = code[pc++]
        try {
          switch (op) {
            case OPCODES.ENTER_SCOPE: {
              var enterCount = code[pc++]
              var enterSlots = []
              for (var enterIndex = 0; enterIndex < enterCount; enterIndex++) {
                enterSlots.push(code[pc++])
              }
              env = createScopeEnv(meta, env, env.thisValue, env.args, enterSlots, null)
              break
            }
            case OPCODES.LEAVE_SCOPE:
              env = env.parent
              break
            case OPCODES.REPLACE_SCOPE: {
              var replaceCount = code[pc++]
              var replaceSlots = []
              for (var replaceIndex = 0; replaceIndex < replaceCount; replaceIndex++) {
                replaceSlots.push(code[pc++])
              }
              env = createScopeEnv(meta, env.parent, env.thisValue, env.args, replaceSlots, env)
              break
            }
            case OPCODES.LOAD_CONST:
              regs[code[pc++]] = metadata.constantPool[code[pc++]]
              break
            case OPCODES.LOAD_UNDEFINED:
              regs[code[pc++]] = undefined
              break
            case OPCODES.MOVE: {
              var moveDst = code[pc++]
              var moveSrc = code[pc++]
              regs[moveDst] = regs[moveSrc]
              break
            }
            case OPCODES.LOAD_SLOT: {
              var dst = code[pc++]
              var depth = code[pc++]
              var slot = code[pc++]
              regs[dst] = readSlot(resolveEnv(env, depth), slot)
              break
            }
            case OPCODES.INIT_SLOT: {
              var initDepth = code[pc++]
              var initSlot = code[pc++]
              var initSrc = code[pc++]
              writeSlot(resolveEnv(env, initDepth), initSlot, regs[initSrc], true)
              break
            }
            case OPCODES.STORE_SLOT: {
              var storeDepth = code[pc++]
              var storeSlot = code[pc++]
              var storeSrc = code[pc++]
              writeSlot(resolveEnv(env, storeDepth), storeSlot, regs[storeSrc], false)
              break
            }
            case OPCODES.LOAD_GLOBAL:
              regs[code[pc++]] = readGlobal(metadata.constantPool[code[pc++]])
              break
            case OPCODES.STORE_GLOBAL:
              globalObject[metadata.constantPool[code[pc++]]] = regs[code[pc++]]
              break
            case OPCODES.LOAD_THIS:
              regs[code[pc++]] = env.thisValue
              break
            case OPCODES.LOAD_ARGUMENTS:
              regs[code[pc++]] = env.args
              break
            case OPCODES.GET_PROP: {
              var getDst = code[pc++]
              var getObj = regs[code[pc++]]
              var getProp = regs[code[pc++]]
              regs[getDst] = getObj[getProp]
              break
            }
            case OPCODES.SET_PROP: {
              var setDst = code[pc++]
              var setObj = regs[code[pc++]]
              var setProp = regs[code[pc++]]
              var setValue = regs[code[pc++]]
              setObj[setProp] = setValue
              regs[setDst] = setValue
              break
            }
            case OPCODES.DELETE_PROP: {
              var delDst = code[pc++]
              var delObj = regs[code[pc++]]
              var delProp = regs[code[pc++]]
              regs[delDst] = delete delObj[delProp]
              break
            }
            case OPCODES.LOAD_NEW_TARGET:
              regs[code[pc++]] = newTarget
              break
            case OPCODES.BINARY: {
              var binaryDst = code[pc++]
              var left = regs[code[pc++]]
              var right = regs[code[pc++]]
              regs[binaryDst] = binary(code[pc++], left, right)
              break
            }
            case OPCODES.UNARY: {
              var unaryDst = code[pc++]
              var unaryValue = regs[code[pc++]]
              regs[unaryDst] = unary(code[pc++], unaryValue)
              break
            }
            case OPCODES.JUMP:
              pc = code[pc]
              break
            case OPCODES.JUMP_IF_FALSE: {
              var condition = regs[code[pc++]]
              var target = code[pc++]
              if (!condition) {
                pc = target
              }
              break
            }
            case OPCODES.JUMP_IF_NOT_NULLISH: {
              var nullishVal = regs[code[pc++]]
              var nullishTarget = code[pc++]
              if (nullishVal !== null && nullishVal !== undefined) {
                pc = nullishTarget
              }
              break
            }
            case OPCODES.TRY: {
              var tryStart = code[pc++]
              var catchStart = code[pc++]
              var finallyStart = code[pc++]
              var after = code[pc++]
              var catchDepth = code[pc++]
              var catchSlot = code[pc++]
              var tryEnd = catchStart !== after ? catchStart : (finallyStart !== after ? finallyStart : after)
              var catchEnd = finallyStart !== after ? finallyStart : after
              var savedEnv = env
              var tryCompletion = run(tryStart, tryEnd)
              env = savedEnv
              if (tryCompletion.type === THROW && catchStart !== after) {
                if (catchSlot >= 0) {
                  env = createScopeEnv(meta, env, env.thisValue, env.args, [catchSlot], null)
                  writeSlot(resolveEnv(env, 0), catchSlot, tryCompletion.value, true)
                }
                tryCompletion = run(catchStart, catchEnd)
                if (catchSlot >= 0) {
                  env = env.parent
                }
              }
              if (finallyStart !== after) {
                var finallyCompletion = run(finallyStart, after)
                if (finallyCompletion.type !== NORMAL) {
                  tryCompletion = finallyCompletion
                }
              }
              if (tryCompletion.type !== NORMAL) {
                return tryCompletion
              }
              pc = after
              break
            }
            case OPCODES.CALL: {
              var callDst = code[pc++]
              var callFn = regs[code[pc++]]
              var thisIndex = code[pc++]
              var argc = code[pc++]
              var argv = []
              for (var i = 0; i < argc; i++) {
                argv.push(regs[code[pc++]])
              }
              var receiver = thisIndex >= 0 ? regs[thisIndex] : globalObject
              regs[callDst] = Reflect.apply(callFn, receiver, argv)
              break
            }
            case OPCODES.NEW: {
              var newDst = code[pc++]
              var ctor = regs[code[pc++]]
              var newArgc = code[pc++]
              var newArgs = []
              for (var j = 0; j < newArgc; j++) {
                newArgs.push(regs[code[pc++]])
              }
              regs[newDst] = Reflect.construct(ctor, newArgs)
              break
            }
            case OPCODES.AWAIT:
              throw new Error('await opcode cannot execute in sync function')
            case OPCODES.YIELD:
              throw new Error('yield opcode cannot execute in sync function')
            case OPCODES.MAKE_FUNCTION:
              regs[code[pc++]] = createClosure(code[pc++], env)
              break
            case OPCODES.RETURN:
              return completion(RETURN, regs[code[pc++]])
            case OPCODES.THROW:
              return completion(THROW, regs[code[pc++]])
            case OPCODES.ARRAY_NEW:
              regs[code[pc++]] = []
              break
            case OPCODES.OBJECT_NEW:
              regs[code[pc++]] = {}
              break
            case OPCODES.ARRAY_PUSH: {
              var arr = regs[code[pc++]]
              arr.push(regs[code[pc++]])
              break
            }
            case OPCODES.OBJECT_SET: {
              var obj = regs[code[pc++]]
              var key = regs[code[pc++]]
              obj[key] = regs[code[pc++]]
              break
            }
            default:
              throw new Error('Unknown opcode: ' + op + ' at pc ' + (pc - 1))
          }
        } catch (error) {
          return completion(THROW, error)
        }
      }

      return completion(NORMAL, undefined)
    }

    var result = run(meta.entry, meta.end)
    if (result.type === THROW) {
      throw result.value
    }
    return result.value
  }

  async function executeAsync(functionId, parentEnv, thisValue, args, newTarget) {
    var meta = metadata.functions[functionId]
    var env = createEnv(meta, parentEnv, thisValue, args)
    var regs = new Array(meta.registerCount)
    var code = metadata.bytecode
    async function run(start, end) {
      var pc = start
      while (pc < end) {
        var op = code[pc++]
        try {
          switch (op) {
            case OPCODES.ENTER_SCOPE: {
              var enterCount = code[pc++]
              var enterSlots = []
              for (var enterIndex = 0; enterIndex < enterCount; enterIndex++) {
                enterSlots.push(code[pc++])
              }
              env = createScopeEnv(meta, env, env.thisValue, env.args, enterSlots, null)
              break
            }
            case OPCODES.LEAVE_SCOPE:
              env = env.parent
              break
            case OPCODES.REPLACE_SCOPE: {
              var replaceCount = code[pc++]
              var replaceSlots = []
              for (var replaceIndex = 0; replaceIndex < replaceCount; replaceIndex++) {
                replaceSlots.push(code[pc++])
              }
              env = createScopeEnv(meta, env.parent, env.thisValue, env.args, replaceSlots, env)
              break
            }
            case OPCODES.LOAD_CONST:
              regs[code[pc++]] = metadata.constantPool[code[pc++]]
              break
            case OPCODES.LOAD_UNDEFINED:
              regs[code[pc++]] = undefined
              break
            case OPCODES.MOVE: {
              var moveDst = code[pc++]
              var moveSrc = code[pc++]
              regs[moveDst] = regs[moveSrc]
              break
            }
            case OPCODES.LOAD_SLOT: {
              var dst = code[pc++]
              var depth = code[pc++]
              var slot = code[pc++]
              regs[dst] = readSlot(resolveEnv(env, depth), slot)
              break
            }
            case OPCODES.INIT_SLOT: {
              var initDepth = code[pc++]
              var initSlot = code[pc++]
              var initSrc = code[pc++]
              writeSlot(resolveEnv(env, initDepth), initSlot, regs[initSrc], true)
              break
            }
            case OPCODES.STORE_SLOT: {
              var storeDepth = code[pc++]
              var storeSlot = code[pc++]
              var storeSrc = code[pc++]
              writeSlot(resolveEnv(env, storeDepth), storeSlot, regs[storeSrc], false)
              break
            }
            case OPCODES.LOAD_GLOBAL:
              regs[code[pc++]] = readGlobal(metadata.constantPool[code[pc++]])
              break
            case OPCODES.STORE_GLOBAL:
              globalObject[metadata.constantPool[code[pc++]]] = regs[code[pc++]]
              break
            case OPCODES.LOAD_THIS:
              regs[code[pc++]] = env.thisValue
              break
            case OPCODES.LOAD_ARGUMENTS:
              regs[code[pc++]] = env.args
              break
            case OPCODES.GET_PROP: {
              var getDst = code[pc++]
              var getObj = regs[code[pc++]]
              var getProp = regs[code[pc++]]
              regs[getDst] = getObj[getProp]
              break
            }
            case OPCODES.SET_PROP: {
              var setDst = code[pc++]
              var setObj = regs[code[pc++]]
              var setProp = regs[code[pc++]]
              var setValue = regs[code[pc++]]
              setObj[setProp] = setValue
              regs[setDst] = setValue
              break
            }
            case OPCODES.DELETE_PROP: {
              var delDst = code[pc++]
              var delObj = regs[code[pc++]]
              var delProp = regs[code[pc++]]
              regs[delDst] = delete delObj[delProp]
              break
            }
            case OPCODES.LOAD_NEW_TARGET:
              regs[code[pc++]] = newTarget
              break
            case OPCODES.BINARY: {
              var binaryDst = code[pc++]
              var left = regs[code[pc++]]
              var right = regs[code[pc++]]
              regs[binaryDst] = binary(code[pc++], left, right)
              break
            }
            case OPCODES.UNARY: {
              var unaryDst = code[pc++]
              var unaryValue = regs[code[pc++]]
              regs[unaryDst] = unary(code[pc++], unaryValue)
              break
            }
            case OPCODES.JUMP:
              pc = code[pc]
              break
            case OPCODES.JUMP_IF_FALSE: {
              var condition = regs[code[pc++]]
              var target = code[pc++]
              if (!condition) {
                pc = target
              }
              break
            }
            case OPCODES.JUMP_IF_NOT_NULLISH: {
              var nullishVal = regs[code[pc++]]
              var nullishTarget = code[pc++]
              if (nullishVal !== null && nullishVal !== undefined) {
                pc = nullishTarget
              }
              break
            }
            case OPCODES.TRY: {
              var tryStart = code[pc++]
              var catchStart = code[pc++]
              var finallyStart = code[pc++]
              var after = code[pc++]
              var catchDepth = code[pc++]
              var catchSlot = code[pc++]
              var tryEnd = catchStart !== after ? catchStart : (finallyStart !== after ? finallyStart : after)
              var catchEnd = finallyStart !== after ? finallyStart : after
              var tryCompletion = await run(tryStart, tryEnd)
              if (tryCompletion.type === THROW && catchStart !== after) {
                if (catchSlot >= 0) {
                  env = createScopeEnv(meta, env, env.thisValue, env.args, [catchSlot], null)
                  writeSlot(resolveEnv(env, 0), catchSlot, tryCompletion.value, true)
                }
                tryCompletion = await run(catchStart, catchEnd)
                if (catchSlot >= 0) {
                  env = env.parent
                }
              }
              if (finallyStart !== after) {
                var finallyCompletion = await run(finallyStart, after)
                if (finallyCompletion.type !== NORMAL) {
                  tryCompletion = finallyCompletion
                }
              }
              if (tryCompletion.type !== NORMAL) {
                return tryCompletion
              }
              pc = after
              break
            }
            case OPCODES.CALL: {
              var callDst = code[pc++]
              var callFn = regs[code[pc++]]
              var thisIndex = code[pc++]
              var argc = code[pc++]
              var argv = []
              for (var i = 0; i < argc; i++) {
                argv.push(regs[code[pc++]])
              }
              var receiver = thisIndex >= 0 ? regs[thisIndex] : globalObject
              regs[callDst] = Reflect.apply(callFn, receiver, argv)
              break
            }
            case OPCODES.NEW: {
              var newDst = code[pc++]
              var ctor = regs[code[pc++]]
              var newArgc = code[pc++]
              var newArgs = []
              for (var j = 0; j < newArgc; j++) {
                newArgs.push(regs[code[pc++]])
              }
              regs[newDst] = Reflect.construct(ctor, newArgs)
              break
            }
            case OPCODES.AWAIT:
              regs[code[pc++]] = await regs[code[pc++]]
              break
            case OPCODES.YIELD:
              throw new Error('yield opcode cannot execute in async function')
            case OPCODES.MAKE_FUNCTION:
              regs[code[pc++]] = createClosure(code[pc++], env)
              break
            case OPCODES.RETURN:
              return completion(RETURN, regs[code[pc++]])
            case OPCODES.THROW:
              return completion(THROW, regs[code[pc++]])
            case OPCODES.ARRAY_NEW:
              regs[code[pc++]] = []
              break
            case OPCODES.OBJECT_NEW:
              regs[code[pc++]] = {}
              break
            case OPCODES.ARRAY_PUSH: {
              var arr = regs[code[pc++]]
              arr.push(regs[code[pc++]])
              break
            }
            case OPCODES.OBJECT_SET: {
              var obj = regs[code[pc++]]
              var key = regs[code[pc++]]
              obj[key] = regs[code[pc++]]
              break
            }
            default:
              throw new Error('Unknown opcode: ' + op + ' at pc ' + (pc - 1))
          }
        } catch (error) {
          return completion(THROW, error)
        }
      }

      return completion(NORMAL, undefined)
    }

    var result = await run(meta.entry, meta.end)
    if (result.type === THROW) {
      throw result.value
    }
    return result.value
  }

  function* executeGenerator(functionId, parentEnv, thisValue, args, newTarget) {
    var meta = metadata.functions[functionId]
    var env = createEnv(meta, parentEnv, thisValue, args)
    var regs = new Array(meta.registerCount)
    var code = metadata.bytecode

    function* run(start, end) {
      var pc = start
      while (pc < end) {
        var op = code[pc++]
        try {
          switch (op) {
            case OPCODES.ENTER_SCOPE: {
              var enterCount = code[pc++]
              var enterSlots = []
              for (var enterIndex = 0; enterIndex < enterCount; enterIndex++) {
                enterSlots.push(code[pc++])
              }
              env = createScopeEnv(meta, env, env.thisValue, env.args, enterSlots, null)
              break
            }
            case OPCODES.LEAVE_SCOPE:
              env = env.parent
              break
            case OPCODES.REPLACE_SCOPE: {
              var replaceCount = code[pc++]
              var replaceSlots = []
              for (var replaceIndex = 0; replaceIndex < replaceCount; replaceIndex++) {
                replaceSlots.push(code[pc++])
              }
              env = createScopeEnv(meta, env.parent, env.thisValue, env.args, replaceSlots, env)
              break
            }
            case OPCODES.LOAD_CONST:
              regs[code[pc++]] = metadata.constantPool[code[pc++]]
              break
            case OPCODES.LOAD_UNDEFINED:
              regs[code[pc++]] = undefined
              break
            case OPCODES.MOVE: {
              var moveDst = code[pc++]
              var moveSrc = code[pc++]
              regs[moveDst] = regs[moveSrc]
              break
            }
            case OPCODES.LOAD_SLOT: {
              var dst = code[pc++]
              var depth = code[pc++]
              var slot = code[pc++]
              regs[dst] = readSlot(resolveEnv(env, depth), slot)
              break
            }
            case OPCODES.INIT_SLOT: {
              var initDepth = code[pc++]
              var initSlot = code[pc++]
              var initSrc = code[pc++]
              writeSlot(resolveEnv(env, initDepth), initSlot, regs[initSrc], true)
              break
            }
            case OPCODES.STORE_SLOT: {
              var storeDepth = code[pc++]
              var storeSlot = code[pc++]
              var storeSrc = code[pc++]
              writeSlot(resolveEnv(env, storeDepth), storeSlot, regs[storeSrc], false)
              break
            }
            case OPCODES.LOAD_GLOBAL:
              regs[code[pc++]] = readGlobal(metadata.constantPool[code[pc++]])
              break
            case OPCODES.STORE_GLOBAL:
              globalObject[metadata.constantPool[code[pc++]]] = regs[code[pc++]]
              break
            case OPCODES.LOAD_THIS:
              regs[code[pc++]] = env.thisValue
              break
            case OPCODES.LOAD_ARGUMENTS:
              regs[code[pc++]] = env.args
              break
            case OPCODES.GET_PROP: {
              var getDst = code[pc++]
              var getObj = regs[code[pc++]]
              var getProp = regs[code[pc++]]
              regs[getDst] = getObj[getProp]
              break
            }
            case OPCODES.SET_PROP: {
              var setDst = code[pc++]
              var setObj = regs[code[pc++]]
              var setProp = regs[code[pc++]]
              var setValue = regs[code[pc++]]
              setObj[setProp] = setValue
              regs[setDst] = setValue
              break
            }
            case OPCODES.DELETE_PROP: {
              var delDst = code[pc++]
              var delObj = regs[code[pc++]]
              var delProp = regs[code[pc++]]
              regs[delDst] = delete delObj[delProp]
              break
            }
            case OPCODES.LOAD_NEW_TARGET:
              regs[code[pc++]] = newTarget
              break
            case OPCODES.BINARY: {
              var binaryDst = code[pc++]
              var left = regs[code[pc++]]
              var right = regs[code[pc++]]
              regs[binaryDst] = binary(code[pc++], left, right)
              break
            }
            case OPCODES.UNARY: {
              var unaryDst = code[pc++]
              var unaryValue = regs[code[pc++]]
              regs[unaryDst] = unary(code[pc++], unaryValue)
              break
            }
            case OPCODES.JUMP:
              pc = code[pc]
              break
            case OPCODES.JUMP_IF_FALSE: {
              var condition = regs[code[pc++]]
              var target = code[pc++]
              if (!condition) {
                pc = target
              }
              break
            }
            case OPCODES.JUMP_IF_NOT_NULLISH: {
              var nullishVal = regs[code[pc++]]
              var nullishTarget = code[pc++]
              if (nullishVal !== null && nullishVal !== undefined) {
                pc = nullishTarget
              }
              break
            }
            case OPCODES.TRY: {
              var tryStart = code[pc++]
              var catchStart = code[pc++]
              var finallyStart = code[pc++]
              var after = code[pc++]
              var catchDepth = code[pc++]
              var catchSlot = code[pc++]
              var tryEnd = catchStart !== after ? catchStart : (finallyStart !== after ? finallyStart : after)
              var catchEnd = finallyStart !== after ? finallyStart : after
              var tryCompletion = yield* run(tryStart, tryEnd)
              if (tryCompletion.type === THROW && catchStart !== after) {
                if (catchSlot >= 0) {
                  env = createScopeEnv(meta, env, env.thisValue, env.args, [catchSlot], null)
                  writeSlot(resolveEnv(env, 0), catchSlot, tryCompletion.value, true)
                }
                tryCompletion = yield* run(catchStart, catchEnd)
                if (catchSlot >= 0) {
                  env = env.parent
                }
              }
              if (finallyStart !== after) {
                var finallyCompletion = yield* run(finallyStart, after)
                if (finallyCompletion.type !== NORMAL) {
                  tryCompletion = finallyCompletion
                }
              }
              if (tryCompletion.type !== NORMAL) {
                return tryCompletion
              }
              pc = after
              break
            }
            case OPCODES.CALL: {
              var callDst = code[pc++]
              var callFn = regs[code[pc++]]
              var thisIndex = code[pc++]
              var argc = code[pc++]
              var argv = []
              for (var i = 0; i < argc; i++) {
                argv.push(regs[code[pc++]])
              }
              var receiver = thisIndex >= 0 ? regs[thisIndex] : globalObject
              regs[callDst] = Reflect.apply(callFn, receiver, argv)
              break
            }
            case OPCODES.NEW: {
              var newDst = code[pc++]
              var ctor = regs[code[pc++]]
              var newArgc = code[pc++]
              var newArgs = []
              for (var j = 0; j < newArgc; j++) {
                newArgs.push(regs[code[pc++]])
              }
              regs[newDst] = Reflect.construct(ctor, newArgs)
              break
            }
            case OPCODES.AWAIT:
              throw new Error('await opcode cannot execute in generator function')
            case OPCODES.YIELD: {
              var yieldDst = code[pc++]
              var yieldSrc = code[pc++]
              var delegate = code[pc++]
              if (delegate) {
                regs[yieldDst] = yield* regs[yieldSrc]
              } else {
                regs[yieldDst] = yield regs[yieldSrc]
              }
              break
            }
            case OPCODES.MAKE_FUNCTION:
              regs[code[pc++]] = createClosure(code[pc++], env)
              break
            case OPCODES.RETURN:
              return completion(RETURN, regs[code[pc++]])
            case OPCODES.THROW:
              return completion(THROW, regs[code[pc++]])
            case OPCODES.ARRAY_NEW:
              regs[code[pc++]] = []
              break
            case OPCODES.OBJECT_NEW:
              regs[code[pc++]] = {}
              break
            case OPCODES.ARRAY_PUSH: {
              var arr = regs[code[pc++]]
              arr.push(regs[code[pc++]])
              break
            }
            case OPCODES.OBJECT_SET: {
              var obj = regs[code[pc++]]
              var key = regs[code[pc++]]
              obj[key] = regs[code[pc++]]
              break
            }
            default:
              throw new Error('Unknown opcode: ' + op + ' at pc ' + (pc - 1))
          }
        } catch (error) {
          return completion(THROW, error)
        }
      }

      return completion(NORMAL, undefined)
    }

    var result = yield* run(meta.entry, meta.end)
    if (result.type === THROW) {
      throw result.value
    }
    return result.value
  }

  async function* executeAsyncGenerator(functionId, parentEnv, thisValue, args, newTarget) {
    var meta = metadata.functions[functionId]
    var env = createEnv(meta, parentEnv, thisValue, args)
    var regs = new Array(meta.registerCount)
    var code = metadata.bytecode

    async function* run(start, end) {
      var pc = start
      while (pc < end) {
        var op = code[pc++]
        try {
          switch (op) {
            case OPCODES.ENTER_SCOPE: {
              var enterCount = code[pc++]
              var enterSlots = []
              for (var enterIndex = 0; enterIndex < enterCount; enterIndex++) {
                enterSlots.push(code[pc++])
              }
              env = createScopeEnv(meta, env, env.thisValue, env.args, enterSlots, null)
              break
            }
            case OPCODES.LEAVE_SCOPE:
              env = env.parent
              break
            case OPCODES.REPLACE_SCOPE: {
              var replaceCount = code[pc++]
              var replaceSlots = []
              for (var replaceIndex = 0; replaceIndex < replaceCount; replaceIndex++) {
                replaceSlots.push(code[pc++])
              }
              env = createScopeEnv(meta, env.parent, env.thisValue, env.args, replaceSlots, env)
              break
            }
            case OPCODES.LOAD_CONST:
              regs[code[pc++]] = metadata.constantPool[code[pc++]]
              break
            case OPCODES.LOAD_UNDEFINED:
              regs[code[pc++]] = undefined
              break
            case OPCODES.MOVE: {
              var moveDst = code[pc++]
              var moveSrc = code[pc++]
              regs[moveDst] = regs[moveSrc]
              break
            }
            case OPCODES.LOAD_SLOT: {
              var dst = code[pc++]
              var depth = code[pc++]
              var slot = code[pc++]
              regs[dst] = readSlot(resolveEnv(env, depth), slot)
              break
            }
            case OPCODES.INIT_SLOT: {
              var initDepth = code[pc++]
              var initSlot = code[pc++]
              var initSrc = code[pc++]
              writeSlot(resolveEnv(env, initDepth), initSlot, regs[initSrc], true)
              break
            }
            case OPCODES.STORE_SLOT: {
              var storeDepth = code[pc++]
              var storeSlot = code[pc++]
              var storeSrc = code[pc++]
              writeSlot(resolveEnv(env, storeDepth), storeSlot, regs[storeSrc], false)
              break
            }
            case OPCODES.LOAD_GLOBAL:
              regs[code[pc++]] = readGlobal(metadata.constantPool[code[pc++]])
              break
            case OPCODES.STORE_GLOBAL:
              globalObject[metadata.constantPool[code[pc++]]] = regs[code[pc++]]
              break
            case OPCODES.LOAD_THIS:
              regs[code[pc++]] = env.thisValue
              break
            case OPCODES.LOAD_ARGUMENTS:
              regs[code[pc++]] = env.args
              break
            case OPCODES.GET_PROP: {
              var getDst = code[pc++]
              var getObj = regs[code[pc++]]
              var getProp = regs[code[pc++]]
              regs[getDst] = getObj[getProp]
              break
            }
            case OPCODES.SET_PROP: {
              var setDst = code[pc++]
              var setObj = regs[code[pc++]]
              var setProp = regs[code[pc++]]
              var setValue = regs[code[pc++]]
              setObj[setProp] = setValue
              regs[setDst] = setValue
              break
            }
            case OPCODES.DELETE_PROP: {
              var delDst = code[pc++]
              var delObj = regs[code[pc++]]
              var delProp = regs[code[pc++]]
              regs[delDst] = delete delObj[delProp]
              break
            }
            case OPCODES.LOAD_NEW_TARGET:
              regs[code[pc++]] = newTarget
              break
            case OPCODES.BINARY: {
              var binaryDst = code[pc++]
              var left = regs[code[pc++]]
              var right = regs[code[pc++]]
              regs[binaryDst] = binary(code[pc++], left, right)
              break
            }
            case OPCODES.UNARY: {
              var unaryDst = code[pc++]
              var unaryValue = regs[code[pc++]]
              regs[unaryDst] = unary(code[pc++], unaryValue)
              break
            }
            case OPCODES.JUMP:
              pc = code[pc]
              break
            case OPCODES.JUMP_IF_FALSE: {
              var condition = regs[code[pc++]]
              var target = code[pc++]
              if (!condition) {
                pc = target
              }
              break
            }
            case OPCODES.JUMP_IF_NOT_NULLISH: {
              var nullishVal = regs[code[pc++]]
              var nullishTarget = code[pc++]
              if (nullishVal !== null && nullishVal !== undefined) {
                pc = nullishTarget
              }
              break
            }
            case OPCODES.TRY: {
              var tryStart = code[pc++]
              var catchStart = code[pc++]
              var finallyStart = code[pc++]
              var after = code[pc++]
              var catchDepth = code[pc++]
              var catchSlot = code[pc++]
              var tryEnd = catchStart !== after ? catchStart : (finallyStart !== after ? finallyStart : after)
              var catchEnd = finallyStart !== after ? finallyStart : after
              var tryCompletion = yield* run(tryStart, tryEnd)
              if (tryCompletion.type === THROW && catchStart !== after) {
                if (catchSlot >= 0) {
                  env = createScopeEnv(meta, env, env.thisValue, env.args, [catchSlot], null)
                  writeSlot(resolveEnv(env, 0), catchSlot, tryCompletion.value, true)
                }
                tryCompletion = yield* run(catchStart, catchEnd)
                if (catchSlot >= 0) {
                  env = env.parent
                }
              }
              if (finallyStart !== after) {
                var finallyCompletion = yield* run(finallyStart, after)
                if (finallyCompletion.type !== NORMAL) {
                  tryCompletion = finallyCompletion
                }
              }
              if (tryCompletion.type !== NORMAL) {
                return tryCompletion
              }
              pc = after
              break
            }
            case OPCODES.CALL: {
              var callDst = code[pc++]
              var callFn = regs[code[pc++]]
              var thisIndex = code[pc++]
              var argc = code[pc++]
              var argv = []
              for (var i = 0; i < argc; i++) {
                argv.push(regs[code[pc++]])
              }
              var receiver = thisIndex >= 0 ? regs[thisIndex] : globalObject
              regs[callDst] = Reflect.apply(callFn, receiver, argv)
              break
            }
            case OPCODES.NEW: {
              var newDst = code[pc++]
              var ctor = regs[code[pc++]]
              var newArgc = code[pc++]
              var newArgs = []
              for (var j = 0; j < newArgc; j++) {
                newArgs.push(regs[code[pc++]])
              }
              regs[newDst] = Reflect.construct(ctor, newArgs)
              break
            }
            case OPCODES.AWAIT:
              regs[code[pc++]] = await regs[code[pc++]]
              break
            case OPCODES.YIELD: {
              var yieldDst = code[pc++]
              var yieldSrc = code[pc++]
              var delegate = code[pc++]
              if (delegate) {
                regs[yieldDst] = yield* regs[yieldSrc]
              } else {
                regs[yieldDst] = yield regs[yieldSrc]
              }
              break
            }
            case OPCODES.MAKE_FUNCTION:
              regs[code[pc++]] = createClosure(code[pc++], env)
              break
            case OPCODES.RETURN:
              return completion(RETURN, regs[code[pc++]])
            case OPCODES.THROW:
              return completion(THROW, regs[code[pc++]])
            case OPCODES.ARRAY_NEW:
              regs[code[pc++]] = []
              break
            case OPCODES.OBJECT_NEW:
              regs[code[pc++]] = {}
              break
            case OPCODES.ARRAY_PUSH: {
              var arr = regs[code[pc++]]
              arr.push(regs[code[pc++]])
              break
            }
            case OPCODES.OBJECT_SET: {
              var obj = regs[code[pc++]]
              var key = regs[code[pc++]]
              obj[key] = regs[code[pc++]]
              break
            }
            default:
              throw new Error('Unknown opcode: ' + op + ' at pc ' + (pc - 1))
          }
        } catch (error) {
          return completion(THROW, error)
        }
      }

      return completion(NORMAL, undefined)
    }

    var result = yield* run(meta.entry, meta.end)
    if (result.type === THROW) {
      throw result.value
    }
    return result.value
  }

  return executeSync(metadata.entryFunctionId, null, globalObject, [])
}
`
}
