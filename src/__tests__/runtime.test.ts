import { describe, expect, it } from 'vitest'
import { resolveFormat, transform } from '../index'
import { compileAndRunSource, makeTempDir, writeTempFile } from './helpers'

describe('register VM runtime', () => {
  it('runs arithmetic and global result assignment', () => {
    expect(compileAndRunSource('var x = 40 + 2\n__result = x')).toBe(42)
  })

  it('supports closures with parent slot resolution', () => {
    const result = compileAndRunSource(`
      function makeCounter() {
        var count = 0
        return function() {
          count = count + 1
          return count
        }
      }
      var counter = makeCounter()
      counter()
      counter()
      __result = counter()
    `)

    expect(result).toBe(3)
  })

  it('supports constructor calls through NEW opcode', () => {
    const result = compileAndRunSource(`
      function Box(value) {
        this.value = value
      }
      var box = new Box(12)
      __result = box.value
    `)

    expect(result).toBe(12)
  })

  it('supports do-while loops', () => {
    const result = compileAndRunSource(`
      var i = 0
      var sum = 0
      do {
        sum = sum + i
        i++
      } while (i < 4)
      __result = sum
    `)

    expect(result).toBe(6)
  })

  it('supports block-scoped let shadowing', () => {
    const result = compileAndRunSource(`
      let value = 'outer'
      {
        let value = 'inner'
        __shadow = value
      }
      __result = [value, __shadow]
    `)

    expect(result).toEqual(['outer', 'inner'])
  })

  it('enforces TDZ for block-scoped bindings', () => {
    const result = compileAndRunSource(`
      let outcome
      try {
        {
          outcome = value
          let value = 1
        }
      } catch (err) {
        outcome = err && err.name === 'ReferenceError'
      }
      __result = outcome
    `)

    expect(result).toBe(true)
  })

  it('rejects const reassignment', () => {
    const result = compileAndRunSource(`
      let outcome
      try {
        const answer = 42
        answer = 7
      } catch (err) {
        outcome = err && err.name === 'TypeError'
      }
      __result = outcome
    `)

    expect(result).toBe(true)
  })

  it('supports lexical bindings inside for-loops', () => {
    const result = compileAndRunSource(`
      let sum = 0
      for (let i = 0; i < 4; i++) {
        sum = sum + i
      }
      __result = sum
    `)

    expect(result).toBe(6)
  })

  it('supports try/catch/finally', () => {
    const result = compileAndRunSource(`
      function run(flag) {
        try {
          if (flag) {
            throw 'boom'
          }
          return 'ok'
        } catch (err) {
          return 'caught:' + err
        } finally {
          __finally = 'done'
        }
      }
      __result = [run(false), run(true), __finally]
    `)

    expect(result).toEqual(['ok', 'caught:boom', 'done'])
  })

  it('supports class lowering with extends and super', () => {
    const result = compileAndRunSource(`
      class Animal {
        constructor(name) {
          this.name = name
        }
        speak() {
          return this.name + ' noise'
        }
      }
      class Dog extends Animal {
        constructor(name) {
          super(name)
        }
        speak() {
          return super.speak() + ' bark'
        }
      }
      var dog = new Dog('Rex')
      __result = dog.speak()
    `)

    expect(result).toBe('Rex noise bark')
  })

  it('supports async functions and await', async () => {
    const promise = compileAndRunSource(`
      async function run() {
        var x = await Promise.resolve(5)
        return x + 1
      }
      __result = run()
    `)

    expect(typeof promise.then).toBe('function')
    await expect(promise).resolves.toBe(6)
  })

  it('supports async try/catch', async () => {
    const promise = compileAndRunSource(`
      async function run() {
        try {
          await Promise.reject('x')
          return 'nope'
        } catch (err) {
          return 'caught:' + err
        }
      }
      __result = run()
    `)

    await expect(promise).resolves.toBe('caught:x')
  })

  it('supports async generators with await and yield delegation', async () => {
    const iterator = compileAndRunSource(`
      async function* inner() {
        yield await Promise.resolve('b')
        return 'done'
      }
      async function* outer() {
        yield await Promise.resolve('a')
        var tail = yield* inner()
        return tail + '!'
      }
      __result = outer()
    `)

    await expect(iterator.next()).resolves.toEqual({ value: 'a', done: false })
    await expect(iterator.next()).resolves.toEqual({ value: 'b', done: false })
    await expect(iterator.next()).resolves.toEqual({ value: 'done!', done: true })
  })

  it('supports generator functions and yield delegation', () => {
    const result = compileAndRunSource(`
      function* inner() {
        yield 'a'
        yield 'b'
      }
      function* outer() {
        var first = yield 1
        var delegated = yield* inner()
        return [first, delegated]
      }
      var it = outer()
      var r1 = it.next()
      var r2 = it.next(10)
      var r3 = it.next()
      var r4 = it.next()
      __result = [r1.value, r1.done, r2.value, r3.value, r4.value[0], r4.done]
    `)

    expect(result).toEqual([1, false, 'a', 'b', 10, true])
  })

  it('supports instance fields and private class elements in declaration order', () => {
    const result = compileAndRunSource(`
      class Counter {
        value = 2
        #secret = this.value + 1
        total = this.#secret + 1
        #double(input) {
          return input * this.#secret
        }
        bump() {
          this.#secret = this.#secret + 1
          return this.#double(this.value)
        }
        reveal() {
          return this.#secret
        }
        static label = 'Counter'
        static #version = Counter.label.length
        static next = Counter.#version + 1
        static version() {
          return this.#version
        }
      }
      var counter = new Counter()
      __result = [counter.value, counter.total, counter.bump(), counter.reveal(), Counter.label, Counter.version(), Counter.next]
    `)

    expect(result).toEqual([2, 4, 8, 4, 'Counter', 7, 8])
  })

  it('keeps catch bindings scoped to the catch block', () => {
    const result = compileAndRunSource(`
      var err = 'outer'
      function run() {
        var reader
        try {
          throw 'inner'
        } catch (err) {
          reader = function() {
            return err
          }
        }
        return [err, reader()]
      }
      __result = run()
    `)

    expect(result).toEqual(['outer', 'inner'])
  })

  it('supports RegExp literals', () => {
    const result = compileAndRunSource(`
      var re = /ab+/gi
      __result = [re instanceof RegExp, re.source, re.flags, re.test('ABBB')]
    `)

    expect(result).toEqual([true, 'ab+', 'gi', true])
  })

  it('supports object literal methods and accessors', () => {
    const result = compileAndRunSource(`
      var dynamic = 'speak'
      var obj = {
        value: 1,
        [dynamic]() {
          return this.value + 1
        },
        get total() {
          return this.value + 2
        },
        set total(v) {
          this.value = v - 2
        }
      }
      var first = obj.speak()
      var getter = obj.total
      var assigned = (obj.total = 10)
      __result = [first, getter, assigned, obj.value, obj.total]
    `)

    expect(result).toEqual([2, 3, 10, 8, 10])
  })

  it('supports optional chaining for property access and calls', () => {
    const result = compileAndRunSource(`
      var nil = null
      var steps = 0
      var obj = {
        value: 2,
        nested: {
          value: 4,
          fn() {
            steps += this.value
            return {
              deep: this.value + 1,
              call() {
                return this.deep + 1
              }
            }
          }
        }
      }
      var missing = nil?.nested?.value
      var hit = obj?.nested?.value
      var callHit = obj?.nested?.fn()?.deep
      var callMiss = nil?.nested?.fn()?.deep
      var optionalMethod = obj.nested.fn?.()
      var optionalMissingMethod = obj.nested.missing?.()
      __result = [missing, hit, callHit, callMiss, optionalMethod.deep, optionalMethod.call(), optionalMissingMethod, steps]
    `)

    expect(result).toEqual([undefined, 4, 5, undefined, 5, 6, undefined, 8])
  })

  it('supports switch statements with fallthrough and default', () => {
    const result = compileAndRunSource(`
      function classify(value) {
        switch (value) {
          case 1:
            return 'one'
          case 2:
          case 3:
            return 'small'
          default:
            return 'other'
        }
      }
      __result = [classify(1), classify(2), classify(3), classify(9)]
    `)

    expect(result).toEqual(['one', 'small', 'small', 'other'])
  })

  it('supports lexical declarations inside switch cases', () => {
    const result = compileAndRunSource(`
      var out = []
      switch (2) {
        case 1:
          let a = 'x'
          out.push(a)
          break
        case 2:
          let b = 'y'
          out.push(b)
          break
        default:
          out.push('z')
      }
      __result = out.join(',')
    `)

    expect(result).toBe('y')
  })

  it('supports compound assignment operators and member updates', () => {
    const result = compileAndRunSource(`
      var x = 5
      x += 3
      x *= 2
      x -= 4
      var obj = { count: 1 }
      var a = obj.count++
      var b = ++obj.count
      obj.count &&= 10
      obj.count ??= 20
      __result = [x, a, b, obj.count]
    `)

    expect(result).toEqual([12, 1, 3, 10])
  })

  it('supports nullish coalescing and array holes', () => {
    const result = compileAndRunSource(`
      var a = null ?? 'fallback'
      var b = 0 ?? 'nope'
      var arr = [1, , 3]
      __result = [a, b, arr.length, 1 in arr, arr[1], arr[2]]
    `)

    expect(result).toEqual(['fallback', 0, 3, true, undefined, 3])
  })

  it('supports instanceof and in operators', () => {
    const result = compileAndRunSource(`
      function Box() {}
      var box = new Box()
      var obj = { a: 1 }
      __result = [box instanceof Box, 'a' in obj, 'b' in obj]
    `)

    expect(result).toEqual([true, true, false])
  })

  it('supports object and array destructuring with defaults and rest', () => {
    const result = compileAndRunSource(`
      var source = { a: 1, b: 2, c: 3 }
      const { a, b: alias = 20, d = 4, ...rest } = source
      const [first, , third = 30, ...tail] = [10, 20, undefined, 40, 50]
      __result = [a, alias, d, rest.c, first, third, tail[0], tail[1]]
    `)

    expect(result).toEqual([1, 2, 4, 3, 10, 30, 40, 50])
  })

  it('supports nested and parameter destructuring', () => {
    const result = compileAndRunSource(`
      function readUser({ profile: { name }, tags = [] }) {
        return [name, tags[0]]
      }
      function pair([a, b]) {
        return a + b
      }
      __result = [readUser({ profile: { name: 'Ada' }, tags: ['x'] }), pair([2, 3])]
    `)

    expect(result).toEqual([['Ada', 'x'], 5])
  })

  it('supports rest parameters and spread in calls, arrays, objects, and new', () => {
    const result = compileAndRunSource(`
      function sum(a, b, c) {
        return a + b + c
      }
      function collect(head, ...rest) {
        return [head, rest.length, rest[0], rest[1]]
      }
      function Box(value) {
        this.value = value
      }
      var nums = [2, 3]
      var call = sum(1, ...nums)
      var rest = collect(1, 2, 3)
      var arr = [0, ...nums, 4]
      var obj = { a: 1, ...{ b: 2 }, c: 3 }
      var box = new Box(...['ok'])
      __result = [call, rest, arr, obj.a, obj.b, obj.c, box.value]
    `)

    expect(result).toEqual([6, [1, 2, 2, 3], [0, 2, 3, 4], 1, 2, 3, 'ok'])
  })

  it('supports for...of and for...in', () => {
    const result = compileAndRunSource(`
      var values = []
      for (const x of [1, 2, 3]) {
        values.push(x)
      }
      var keys = []
      for (const key in { a: 1, b: 2 }) {
        keys.push(key)
      }
      __result = [values.join(','), keys.sort().join(',')]
    `)

    expect(result).toEqual(['1,2,3', 'a,b'])
  })

  it('supports for await...of', async () => {
    const promise = compileAndRunSource(`
      async function* gen() {
        yield await Promise.resolve(1)
        yield await Promise.resolve(2)
      }
      async function run() {
        var sum = 0
        for await (const value of gen()) {
          sum += value
        }
        return sum
      }
      __result = run()
    `)

    await expect(promise).resolves.toBe(3)
  })

  it('supports private accessors', () => {
    const result = compileAndRunSource(`
      class Counter {
        #value = 1
        get #secret() {
          return this.#value + 1
        }
        set #secret(v) {
          this.#value = v - 1
        }
        read() {
          return this.#secret
        }
        write(v) {
          return this.#secret = v
        }
      }
      class Store {
        static #n = 5
        static get #secret() {
          return this.#n * 2
        }
        static set #secret(v) {
          this.#n = v / 2
        }
        static read() {
          return this.#secret
        }
        static write(v) {
          return this.#secret = v
        }
      }
      var counter = new Counter()
      __result = [counter.read(), counter.write(11), counter.read(), Store.read(), Store.write(14), Store.read()]
    `)

    expect(result).toEqual([2, 11, 11, 10, 14, 14])
  })

  it('keeps per-iteration lexical capture fresh in for loops', () => {
    const result = compileAndRunSource(`
      var fns = []
      for (let i = 0; i < 3; i++) {
        fns.push(function() { return i })
      }
      __result = [fns[0](), fns[1](), fns[2]()]
    `)

    expect(result).toEqual([0, 1, 2])
  })

  it('keeps catch bindings fresh across loop iterations', () => {
    const result = compileAndRunSource(`
      var fns = []
      for (let i = 0; i < 3; i++) {
        try {
          throw i
        } catch (e) {
          fns.push(function() { return e })
        }
      }
      __result = [fns[0](), fns[1](), fns[2]()]
    `)

    expect(result).toEqual([0, 1, 2])
  })

  it('captures lexical this in arrow functions', () => {
    const result = compileAndRunSource(`
      function Obj() {
        this.value = 1
        this.get = function() {
          var arrow = () => this.value
          return arrow()
        }
      }
      var o = new Obj()
      __result = o.get()
    `)

    expect(result).toBe(1)
  })

  it('arrow this is immune to call/apply rebinding', () => {
    const result = compileAndRunSource(`
      function Thing() {
        this.v = 5
        this.f = () => this.v
      }
      var t = new Thing()
      __result = t.f.call({ v: 99 })
    `)

    expect(result).toBe(5)
  })

  it('captures lexical arguments in arrow functions', () => {
    const result = compileAndRunSource(`
      function outer() {
        var f = () => arguments[0] + arguments[1]
        return f()
      }
      __result = outer(10, 20)
    `)

    expect(result).toBe(30)
  })

  it('nested arrows share the outer lexical this', () => {
    const result = compileAndRunSource(`
      function Outer() {
        this.x = 7
        this.get = () => {
          var inner = () => this.x
          return inner()
        }
      }
      __result = new Outer().get()
    `)

    expect(result).toBe(7)
  })

  it('closes iterator on break in for...of', () => {
    const result = compileAndRunSource(`
      var log = []
      var iterable = {}
      iterable[Symbol.iterator] = function() {
        var i = 0
        return {
          next: function() {
            i++
            return i <= 3 ? { value: i, done: false } : { value: undefined, done: true }
          },
          return: function() {
            log.push('closed')
            return { done: true }
          }
        }
      }
      for (var x of iterable) {
        if (x === 2) break
      }
      __result = log
    `)

    expect(result).toEqual(['closed'])
  })

  it('does not close iterator on normal completion', () => {
    const result = compileAndRunSource(`
      var log = []
      var iterable = {}
      iterable[Symbol.iterator] = function() {
        var i = 0
        return {
          next: function() {
            i++
            return i <= 2 ? { value: i, done: false } : { value: undefined, done: true }
          },
          return: function() {
            log.push('closed')
            return { done: true }
          }
        }
      }
      for (var x of iterable) {
        log.push(x)
      }
      __result = log
    `)

    expect(result).toEqual([1, 2])
  })

  it('closes async iterator on break in for await...of', async () => {
    const promise = compileAndRunSource(`
      var log = []
      async function run() {
        var iterable = {}
        iterable[Symbol.asyncIterator] = function() {
          var i = 0
          return {
            next: function() {
              i++
              return Promise.resolve(
                i <= 3 ? { value: i, done: false } : { value: undefined, done: true }
              )
            },
            return: function() {
              log.push('closed')
              return Promise.resolve({ done: true })
            }
          }
        }
        for await (var x of iterable) {
          if (x === 2) break
        }
        return log
      }
      __result = run()
    `)

    await expect(promise).resolves.toEqual(['closed'])
  })

  it('supports assignment destructuring with rest and defaults', () => {
    const result = compileAndRunSource(`
      var a, b, rest, x, y, tail
      ;({a, b = 20, ...rest} = {a: 1, c: 3, d: 4})
      ;([x, y = 30, ...tail] = [10, undefined, 40, 50])
      __result = [a, b, rest.c, rest.d, x, y, tail[0], tail[1]]
    `)

    expect(result).toEqual([1, 20, 3, 4, 10, 30, 40, 50])
  })

  it('supports delete operator on object properties', () => {
    const result = compileAndRunSource(`
      var obj = { a: 1, b: 2 }
      var r1 = delete obj.a
      var key = 'b'
      var r2 = delete obj[key]
      var r3 = delete {}.foo
      __result = [r1, obj.a, 'a' in obj, r2, 'b' in obj, r3]
    `)

    expect(result).toEqual([true, undefined, false, true, false, true])
  })

  it('supports class static blocks', () => {
    const result = compileAndRunSource(`
      class Foo {
        static value = 1
        static { Foo.value = Foo.value + 10 }
        static extra = Foo.value + 5
      }
      __result = [Foo.value, Foo.extra]
    `)

    expect(result).toEqual([11, 16])
  })

  it('supports destructured constructor parameters', () => {
    const result = compileAndRunSource(`
      class Point {
        constructor({ x, y }) {
          this.x = x
          this.y = y
        }
      }
      var p = new Point({ x: 3, y: 4 })
      __result = [p.x, p.y]
    `)

    expect(result).toEqual([3, 4])
  })

  it('supports default and rest function parameters', () => {
    const result = compileAndRunSource(`
      function greet(name = 'world') { return 'hello ' + name }
      function sum(a, ...rest) {
        var total = a
        for (var i = 0; i < rest.length; i++) total += rest[i]
        return total
      }
      class Box { constructor(v = 10) { this.v = v } }
      __result = [greet(), greet('Alice'), sum(1, 2, 3), new Box().v, new Box(5).v]
    `)

    expect(result).toEqual(['hello world', 'hello Alice', 6, 10, 5])
  })

  it('supports BigInt literals', () => {
    const result = compileAndRunSource(`
      var a = 123n
      var b = 456n
      __result = [typeof a, a + b === 579n, a < b]
    `)

    expect(result).toEqual(['bigint', true, true])
  })

  it('supports tagged template expressions', () => {
    const result = compileAndRunSource(`
      function tag(strings) {
        var result = strings[0]
        for (var i = 1; i < arguments.length; i++) {
          result = result + arguments[i] + strings[i]
        }
        return result
      }
      __result = tag\`a\${1}b\${2}c\`
    `)

    expect(result).toBe('a1b2c')
  })

  it('preserves raw strings in tagged templates', () => {
    const result = compileAndRunSource(`
      function raw(s) { return s.raw[0] }
      __result = raw\`\\n\`
    `)

    expect(result).toBe('\\n')
  })

  it('supports labeled break from nested loops', () => {
    const result = compileAndRunSource(`
      var result = []
      outer: for (var i = 0; i < 3; i++) {
        for (var j = 0; j < 3; j++) {
          if (j === 1) continue outer
          result.push(i + ',' + j)
        }
      }
      __result = result
    `)

    expect(result).toEqual(['0,0', '1,0', '2,0'])
  })

  it('supports labeled block break', () => {
    const result = compileAndRunSource(`
      var x = 0
      block: {
        x = 1
        break block
        x = 2
      }
      __result = x
    `)

    expect(result).toBe(1)
  })

  it('supports debugger statement as no-op', () => {
    const result = compileAndRunSource(`
      debugger
      __result = 42
    `)

    expect(result).toBe(42)
  })

  it('supports arrow this inside class methods', () => {
    const result = compileAndRunSource(`
      class Obj {
        constructor(v) { this.v = v }
        get() {
          var f = () => this.v
          return f()
        }
      }
      __result = new Obj(42).get()
    `)

    expect(result).toBe(42)
  })

  it('supports arrow super inside class methods', () => {
    const result = compileAndRunSource(`
      class Base {
        speak() { return 'base' }
      }
      class Child extends Base {
        speak() {
          var f = () => super.speak() + '!'
          return f()
        }
      }
      __result = new Child().speak()
    `)

    expect(result).toBe('base!')
  })

  it('supports new.target in constructors', () => {
    const result = compileAndRunSource(`
      function Foo() {
        __nt = new.target
      }
      new Foo()
      var nt1 = __nt
      Foo()
      var nt2 = __nt
      __result = [nt1 === Foo, nt2 === undefined]
    `)

    expect(result).toEqual([true, true])
  })

  it('captures new.target in arrow functions', () => {
    const result = compileAndRunSource(`
      function Bar() {
        this.check = () => new.target
      }
      var b = new Bar()
      __result = b.check() === Bar
    `)

    expect(result).toBe(true)
  })

  it('compiles dynamic import() syntax', () => {
    const dir = makeTempDir('script-vm-next-import-')
    const input = writeTempFile(dir, 'input.js', `
      async function load() {
        var m = await import('./other.js')
        return m.default
      }
      __result = 'compiled'
    `)
    const code = transform(input, { format: 'iife' })
    expect(code).toContain('__vm_import')
  })

  it('rejects obfuscation for v0.1 explicitly', () => {
    const dir = makeTempDir('script-vm-next-obf-')
    const input = writeTempFile(dir, 'input.js', '__result = 1')
    expect(() => transform(input, { obfuscate: true })).toThrow(/not implemented/)
  })

  it('detects format from source content', () => {
    expect(resolveFormat('/tmp/example.js', 'export const value = 1')).toBe('esm')
    expect(resolveFormat('/tmp/example.js', 'module.exports = 1')).toBe('cjs')
    expect(resolveFormat('/tmp/example.js', 'var x = 1')).toBe('iife')
  })
})
