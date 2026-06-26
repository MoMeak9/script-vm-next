var __vm_result = (function(){
var __vm_global = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : {});

__vm_global.require = typeof require !== 'undefined' ? require : __vm_global.require;
__vm_global.module = typeof module !== 'undefined' ? module : __vm_global.module;
__vm_global.exports = typeof exports !== 'undefined' ? exports : __vm_global.exports;

function __scriptvmRun(metadata, globalObject) {
  var OPCODES = {"LOAD_CONST":1,"MOVE":2,"LOAD_SLOT":3,"STORE_SLOT":4,"LOAD_GLOBAL":5,"STORE_GLOBAL":6,"GET_PROP":7,"SET_PROP":8,"BINARY":9,"UNARY":10,"JUMP":11,"JUMP_IF_FALSE":12,"CALL":13,"MAKE_FUNCTION":14,"RETURN":15,"LOAD_THIS":16,"LOAD_ARGUMENTS":17,"ARRAY_NEW":18,"OBJECT_NEW":19,"ARRAY_PUSH":20,"OBJECT_SET":21,"LOAD_UNDEFINED":22,"NEW":23,"THROW":24};
  var BINARY_OPS = {"+":1,"-":2,"*":3,"/":4,"%":5,"==":6,"===":7,"!=":8,"!==":9,">":10,">=":11,"<":12,"<=":13,"&&":14,"||":15};
  var UNARY_OPS = {"!":1,"-":2,"+":3,"typeof":4,"void":5};

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

  function createClosure(functionId, parentEnv) {
    return function() {
      return execute(functionId, parentEnv, this, Array.prototype.slice.call(arguments))
    }
  }

  function execute(functionId, parentEnv, thisValue, args) {
    var meta = metadata.functions[functionId]
    var env = {
      values: new Array(meta.slotCount),
      parent: parentEnv,
      thisValue: thisValue,
      args: args,
    }
    var regs = new Array(meta.registerCount)
    var code = metadata.bytecode
    var i

    for (i = 0; i < meta.params; i++) {
      env.values[i] = args[i]
    }

    var pc = meta.entry
    while (pc < code.length) {
      var op = code[pc++]
      switch (op) {
        case OPCODES.LOAD_CONST:
          regs[code[pc++]] = metadata.constantPool[code[pc++]]
          break
        case OPCODES.LOAD_UNDEFINED:
          regs[code[pc++]] = undefined
          break
        case OPCODES.MOVE:
          regs[code[pc++]] = regs[code[pc++]]
          break
        case OPCODES.LOAD_SLOT: {
          var dst = code[pc++]
          var depth = code[pc++]
          var slot = code[pc++]
          regs[dst] = resolveEnv(env, depth).values[slot]
          break
        }
        case OPCODES.STORE_SLOT: {
          var storeDepth = code[pc++]
          var storeSlot = code[pc++]
          var storeSrc = code[pc++]
          resolveEnv(env, storeDepth).values[storeSlot] = regs[storeSrc]
          break
        }
        case OPCODES.LOAD_GLOBAL:
          regs[code[pc++]] = globalObject[metadata.constantPool[code[pc++]]]
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
        case OPCODES.CALL: {
          var callDst = code[pc++]
          var callFn = regs[code[pc++]]
          var thisIndex = code[pc++]
          var argc = code[pc++]
          var argv = []
          for (i = 0; i < argc; i++) {
            argv.push(regs[code[pc++]])
          }
          var receiver = thisIndex >= 0 ? regs[thisIndex] : globalObject
          regs[callDst] = callFn.apply(receiver, argv)
          break
        }
        case OPCODES.NEW: {
          var newDst = code[pc++]
          var ctor = regs[code[pc++]]
          var newArgc = code[pc++]
          var newArgs = []
          for (i = 0; i < newArgc; i++) {
            newArgs.push(regs[code[pc++]])
          }
          regs[newDst] = Reflect.construct(ctor, newArgs)
          break
        }
        case OPCODES.MAKE_FUNCTION:
          regs[code[pc++]] = createClosure(code[pc++], env)
          break
        case OPCODES.RETURN:
          return regs[code[pc++]]
        case OPCODES.THROW:
          throw regs[code[pc++]]
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
    }

    return undefined
  }

  return execute(metadata.entryFunctionId, null, globalObject, [])
}

return __scriptvmRun({"format":"cjs","bytecode":[14,0,1,13,1,0,-1,0,22,2,15,2,1,0,0,5,1,1,1,2,2,7,3,1,2,13,4,3,1,1,0,22,5,15,5],"constantPool":["Hello, World!","console","log"],"functions":[{"id":0,"name":null,"entry":0,"registerCount":3,"slotCount":0,"params":0,"slotNames":[]},{"id":1,"name":null,"entry":12,"registerCount":6,"slotCount":0,"params":0,"slotNames":[]}],"entryFunctionId":0,"exportNames":[]}, __vm_global);
})();
module.exports = __vm_result;
