/** Host operations used only by compiler-generated destructuring/iteration code.
 * Source bindings cannot shadow their reserved LOAD_GLOBAL names.
 */
export const iteratorRuntimeSource = `
  var iteratorIntrinsicApply = Reflect.apply;
  var iteratorIntrinsicConstruct = Reflect.construct;
  var iteratorIntrinsicSymbol = Symbol.iterator;
  var iteratorIntrinsicTypeError = TypeError;
  var iteratorIntrinsicObject = Object;
  var iteratorIntrinsicOwnKeys = Reflect.ownKeys;
  var iteratorIntrinsicDescriptor = Object.getOwnPropertyDescriptor;
  var iteratorIntrinsicDefine = Object.defineProperty;
  function iteratorIsObject(value) {
    return value !== null && (typeof value === 'object' || typeof value === 'function');
  }
  function iteratorStart(value) {
    if (value == null) throw new iteratorIntrinsicTypeError('Value is not iterable');
    var method = value[iteratorIntrinsicSymbol];
    var iterator = iteratorIntrinsicApply(method, value, []);
    if (!iteratorIsObject(iterator)) throw new iteratorIntrinsicTypeError('Iterator is not an object');
    return { iterator: iterator, next: iterator.next, done: false };
  }
  function iteratorStep(record, skipValue) {
    if (record.done) return undefined;
    // A throwing next/done/value operation must not invoke this iterator's return.
    record.done = true;
    var result = iteratorIntrinsicApply(record.next, record.iterator, []);
    if (!iteratorIsObject(result)) throw new iteratorIntrinsicTypeError('Iterator result is not an object');
    if (result.done) return undefined;
    var value = skipValue ? undefined : result.value;
    record.done = false;
    return value;
  }
  function iteratorRest(record) {
    var result = [];
    while (!record.done) {
      var value = iteratorStep(record);
      if (!record.done) result[result.length] = value;
    }
    return result;
  }
  function iteratorClose(record, abrupt) {
    if (record.done) return;
    record.done = true;
    try {
      var method = record.iterator.return;
      if (method == null) return;
      var result = iteratorIntrinsicApply(method, record.iterator, []);
      if (!iteratorIsObject(result)) throw new iteratorIntrinsicTypeError('Iterator return result is not an object');
    } catch (error) {
      if (!abrupt) throw error;
    }
  }
  function requireObject(value) {
    if (value == null) throw new iteratorIntrinsicTypeError('Cannot destructure null or undefined');
    return value;
  }
  function propertyKey(value) {
    // Computed property definition performs the spec ToPropertyKey operation.
    return iteratorIntrinsicOwnKeys({ [value]: 0 })[0];
  }
  function objectRest(value, excludes) {
    var result = {};
    var object = iteratorIntrinsicObject(requireObject(value));
    var keys = iteratorIntrinsicOwnKeys(object);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var excluded = false;
      for (var j = 0; j < excludes.length; j++) if (excludes[j] === key) excluded = true;
      if (excluded) continue;
      var descriptor = iteratorIntrinsicDescriptor(object, key);
      if (descriptor && descriptor.enumerable) {
        iteratorIntrinsicDefine(result, key, { value: object[key], writable: true, enumerable: true, configurable: true });
      }
    }
    return result;
  }
  function flattenArrays(arrays) {
    var result = [];
    var offset = 0;
    for (var i = 0; i < arrays.length; i++) {
      var array = arrays[i];
      for (var j = 0; j < array.length; j++) {
        // Literal holes remain holes; spread operands already contain values.
        var descriptor = iteratorIntrinsicDescriptor(array, j);
        if (descriptor) iteratorIntrinsicDefine(result, offset + j, {
          value: array[j], writable: true, enumerable: true, configurable: true
        });
      }
      offset += array.length;
    }
    result.length = offset;
    return result;
  }
  function* enumerateKeys(value) {
    for (var key in value) yield key;
  }
`
