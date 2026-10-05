/** SetFunctionName uses a symbol's internal description, not a mutable public
 * Symbol.prototype.description property. The key has already been coerced. */
export const classRuntimeSource = `
  var classSymbolDescription = Object.getOwnPropertyDescriptor(Symbol.prototype, 'description').get;
  var classReflectApply = Reflect.apply;
  function classFunctionName(key) {
    if (typeof key !== 'symbol') return key;
    var description = classReflectApply(classSymbolDescription, key, []);
    return description === undefined ? '' : '[' + description + ']';
  }
`
