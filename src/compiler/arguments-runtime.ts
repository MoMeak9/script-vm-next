/** Arguments objects need a parameter map only for sloppy, simple parameter
 * lists. Proxy traps implement the map's descriptor and deletion rules without
 * executing user source natively or patching any host built-in. */
export const argumentsRuntimeSource = `
  var argumentsDefine = Object.defineProperty;
  var argumentsCreate = Object.create;
  var argumentsAssign = Object.assign;
  var argumentsOwn = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
  var argumentsGet = Reflect.get;
  var argumentsHas = Reflect.has;
  var argumentsGetDescriptor = Reflect.getOwnPropertyDescriptor;
  var argumentsDefineDescriptor = Reflect.defineProperty;
  var argumentsDelete = Reflect.deleteProperty;
  var argumentsApply = Reflect.apply;
  var argumentsIteratorKey = Symbol.iterator;
  var argumentsIterator = Array.prototype[argumentsIteratorKey];
  var argumentsTag = Symbol.toStringTag;
  function argumentValues(source, callee) {
    var values = arraySlice(source, 0);
    values.callee = callee;
    return values;
  }
  function createArguments(meta, env, values) {
    if (meta.strict || !meta.simpleParameters) {
      return argumentsApply(function() { 'use strict'; return arguments; }, undefined, values);
    }
    var target = {};
    var mapping = argumentsCreate(null);
    var seen = argumentsCreate(null);
    for (var i = 0; i < values.length; i++) {
      argumentsDefine(target, String(i), {
        value: values[i], writable: true, enumerable: true, configurable: true
      });
    }
    argumentsDefine(target, 'length', {
      value: values.length, writable: true, enumerable: false, configurable: true
    });
    argumentsDefine(target, 'callee', {
      value: values.callee, writable: true, enumerable: false, configurable: true
    });
    argumentsDefine(target, argumentsIteratorKey, {
      value: argumentsIterator, writable: true, enumerable: false, configurable: true
    });
    // Only the final occurrence of a duplicate formal parameter is mapped,
    // including when that final occurrence has no corresponding argument.
    for (var i = meta.parameterSlots.length - 1; i >= 0; i--) {
      var slot = meta.parameterSlots[i];
      if (!seen[slot]) {
        seen[slot] = true;
        if (i < values.length) mapping[String(i)] = slot;
      }
    }
    return new intrinsicProxy(target, {
      get: function(object, key, receiver) {
        if (argumentsOwn(mapping, key)) return env.values[mapping[key]];
        // Proxy objects have no native Arguments internal tag. Expose the tag
        // virtually, without adding an own property or changing ownKeys.
        if (key === argumentsTag && !argumentsHas(object, key)) return 'Arguments';
        return argumentsGet(object, key, receiver);
      },
      getOwnPropertyDescriptor: function(object, key) {
        var descriptor = argumentsGetDescriptor(object, key);
        if (descriptor && argumentsOwn(mapping, key)) {
          descriptor.value = env.values[mapping[key]];
        }
        return descriptor;
      },
      defineProperty: function(object, key, descriptor) {
        var mapped = argumentsOwn(mapping, key);
        // A writable:false descriptor without a value snapshots the current
        // parameter before disconnecting the map (ES Arguments [[DefineOwnProperty]]).
        var next = descriptor;
        if (mapped && descriptor.writable === false && !('value' in descriptor) && !('get' in descriptor) && !('set' in descriptor)) {
          next = argumentsAssign({}, descriptor, { value: env.values[mapping[key]] });
        }
        if (!argumentsDefineDescriptor(object, key, next)) return false;
        if (mapped) {
          if ('get' in descriptor || 'set' in descriptor) delete mapping[key];
          else {
            if ('value' in descriptor) env.values[mapping[key]] = descriptor.value;
            if (descriptor.writable === false) delete mapping[key];
          }
        }
        return true;
      },
      deleteProperty: function(object, key) {
        if (!argumentsDelete(object, key)) return false;
        delete mapping[key];
        return true;
      }
    });
  }
`
