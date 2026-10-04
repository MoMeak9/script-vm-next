/** Object-literal operations must not resolve through interpreted Object or
 * Reflect bindings, or invoke inherited setters when defining own properties.
 */
export const objectRuntimeSource = `
  var objectIntrinsicDefine = Object.defineProperty;
  var objectIntrinsicDescriptor = Object.getOwnPropertyDescriptor;
  var objectIntrinsicGetPrototype = Object.getPrototypeOf;
  var objectIntrinsicSetPrototype = Object.setPrototypeOf;
  var objectIntrinsicOwnKeys = Reflect.ownKeys;
  var objectIntrinsicGet = Reflect.get;
  var objectIntrinsicSet = Reflect.set;
  var objectIntrinsicApply = Reflect.apply;
  var objectIntrinsicSymbolDescription = Object.getOwnPropertyDescriptor(Symbol.prototype, 'description').get;
  function objectFunctionName(key, prefix) {
    if (typeof key === 'symbol') {
      var description = objectIntrinsicApply(objectIntrinsicSymbolDescription, key, []);
      key = description === undefined ? '' : '[' + description + ']';
    }
    return prefix + key;
  }
  function objectDefineData(target, key, value, inferName) {
    if (inferName && typeof value === 'function' && value.name === '') {
      objectIntrinsicDefine(value, 'name', { value: objectFunctionName(key, ''), configurable: true });
    }
    objectIntrinsicDefine(target, key, { value: value, writable: true, enumerable: true, configurable: true });
  }
  function objectDefineMethod(target, key, kind, fn) {
    objectIntrinsicDefine(fn, 'name', { value: objectFunctionName(key, kind === 'value' ? '' : kind + ' '), configurable: true });
    var descriptor = { enumerable: true, configurable: true };
    descriptor[kind] = fn;
    if (kind === 'value') descriptor.writable = true;
    objectIntrinsicDefine(target, key, descriptor);
  }
  function objectSetPrototype(target, value) {
    if (value === null || typeof value === 'object' || typeof value === 'function') objectIntrinsicSetPrototype(target, value);
  }
  function objectSpread(target, value) {
    if (value === null || value === undefined) return;
    var source = intrinsicObject(value);
    var keys = objectIntrinsicOwnKeys(source);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var descriptor = objectIntrinsicDescriptor(source, key);
      if (descriptor && descriptor.enumerable) objectDefineData(target, key, source[key], false);
    }
  }
  function objectSuperReference(home, key, receiver, strict) {
    // A Super Reference captures its base immediately. GetValue/PutValue then
    // coerce and cache its key, after ToObject(base); plain assignment delays
    // this coercion until the right-hand side has been evaluated.
    var base = objectIntrinsicGetPrototype(home);
    var converted = false;
    function referenceKey() {
      if (base === null) throw new intrinsicTypeError('Cannot access a null super base');
      if (!converted) { key = propertyKey(key); converted = true; }
      return key;
    }
    return objectIntrinsicDefine({}, 'value', {
      get: function () { return objectIntrinsicGet(base, referenceKey(), receiver); },
      set: function (value) {
        if (!objectIntrinsicSet(base, referenceKey(), value, receiver) && strict) throw new intrinsicTypeError('Cannot assign to inherited property');
      }
    });
  }
  function objectSuperDelete() { throw new intrinsicReferenceError('Cannot delete a super property'); }
`
