import { describe, expect, it } from 'vitest'
import { compileAndRunSource } from './helpers'

describe('complex ES6 end-to-end verification', () => {

  it('event system: classes + closures + private fields + async + destructuring + arrow this', () => {
    const result = compileAndRunSource(`
      class EventEmitter {
        #handlers = new Map()

        on(event, handler) {
          if (!this.#handlers.has(event)) {
            this.#handlers.set(event, [])
          }
          this.#handlers.get(event).push(handler)
          return this
        }

        emit(event, ...args) {
          const handlers = this.#handlers.get(event) || []
          for (const fn of handlers) {
            fn(...args)
          }
        }
      }

      class Store extends EventEmitter {
        #state

        constructor(initial = {}) {
          super()
          this.#state = { ...initial }
        }

        get(key) {
          return this.#state[key]
        }

        set(key, value) {
          const old = this.#state[key]
          this.#state[key] = value
          // arrow captures lexical this
          const notify = () => this.emit('change', { key, old, value })
          notify()
        }
      }

      const log = []
      const store = new Store({ count: 0, name: 'test' })

      store.on('change', ({ key, old, value }) => {
        log.push(key + ':' + old + '->' + value)
      })

      store.set('count', 1)
      store.set('count', 2)
      store.set('name', 'hello')

      __result = log.join('; ')
    `)
    expect(result).toBe('count:0->1; count:1->2; name:test->hello')
  })

  it('async pipeline: async/await + generators + for-of + closures + template literals', async () => {
    const result = compileAndRunSource(`
      function* range(start, end) {
        for (let i = start; i < end; i++) {
          yield i
        }
      }

      function pipe(...fns) {
        return function(input) {
          let result = input
          for (const fn of fns) {
            result = fn(result)
          }
          return result
        }
      }

      const double = x => x * 2
      const addTen = x => x + 10
      const toString = x => \`value:\${x}\`

      const transform = pipe(double, addTen, toString)

      const results = []
      for (const n of range(1, 5)) {
        results.push(transform(n))
      }

      __result = results.join(', ')
    `)
    expect(result).toBe('value:12, value:14, value:16, value:18')
  })

  it('linked list: classes + optional chaining + Symbol.iterator + generators + for-of', () => {
    const result = compileAndRunSource(`
      class ListNode {
        constructor(value, next = null) {
          this.value = value
          this.next = next
        }
      }

      class LinkedList {
        #head = null
        #size = 0

        push(value) {
          this.#head = new ListNode(value, this.#head)
          this.#size++
          return this
        }

        *[Symbol.iterator]() {
          let current = this.#head
          while (current !== null) {
            yield current.value
            current = current.next
          }
        }

        get length() {
          return this.#size
        }

        find(predicate) {
          for (const val of this) {
            if (predicate(val)) return val
          }
          return undefined
        }

        toArray() {
          return [...this]
        }
      }

      const list = new LinkedList()
      list.push(10).push(20).push(30).push(40).push(50)

      // for-of with break
      let firstOver25
      for (const v of list) {
        if (v > 25) {
          firstOver25 = v
          break
        }
      }

      // optional chaining on find result
      const found = list.find(x => x === 20)
      const notFound = list.find(x => x === 999)

      __result = JSON.stringify({
        length: list.length,
        array: list.toArray(),
        firstOver25,
        found,
        notFound: notFound ?? 'missing'
      })
    `)
    expect(JSON.parse(result)).toEqual({
      length: 5,
      array: [50, 40, 30, 20, 10],
      firstOver25: 50,
      found: 20,
      notFound: 'missing'
    })
  })

  it('state machine: switch + classes + computed properties + destructuring + closures', () => {
    const result = compileAndRunSource(`
      const STATES = {
        IDLE: 'idle',
        LOADING: 'loading',
        SUCCESS: 'success',
        ERROR: 'error',
      }

      class StateMachine {
        #state
        #transitions
        #log = []

        constructor(initial, transitions) {
          this.#state = initial
          this.#transitions = transitions
        }

        get state() { return this.#state }
        get history() { return [...this.#log] }

        dispatch(action, payload) {
          const key = this.#state + ':' + action
          const handler = this.#transitions[key]

          if (!handler) {
            this.#log.push('invalid:' + key)
            return this
          }

          const { next, effect } = handler(this.#state, payload)
          this.#log.push(this.#state + '->' + next)
          this.#state = next
          if (effect) effect()
          return this
        }
      }

      let fetchedData = null

      const machine = new StateMachine(STATES.IDLE, {
        ['idle:fetch']: (state, url) => ({
          next: STATES.LOADING,
          effect: () => { fetchedData = 'loading:' + url }
        }),
        ['loading:resolve']: (state, data) => ({
          next: STATES.SUCCESS,
          effect: () => { fetchedData = data }
        }),
        ['loading:reject']: (state, err) => ({
          next: STATES.ERROR,
          effect: () => { fetchedData = 'error:' + err }
        }),
        ['error:retry']: () => ({
          next: STATES.LOADING,
          effect: null
        }),
        ['success:reset']: () => ({
          next: STATES.IDLE,
          effect: () => { fetchedData = null }
        }),
      })

      machine
        .dispatch('fetch', '/api/data')
        .dispatch('resolve', 'hello world')
        .dispatch('reset')
        .dispatch('fetch', '/api/v2')
        .dispatch('reject', 'timeout')
        .dispatch('retry')

      __result = JSON.stringify({
        state: machine.state,
        history: machine.history,
        data: fetchedData,
      })
    `)
    expect(JSON.parse(result)).toEqual({
      state: 'loading',
      history: [
        'idle->loading',
        'loading->success',
        'success->idle',
        'idle->loading',
        'loading->error',
        'error->loading',
      ],
      data: 'error:timeout',
    })
  })

  it('curried memoize: closures + Map + rest/spread + arrow + compound assignment + optional chaining', () => {
    const result = compileAndRunSource(`
      function memoize(fn) {
        const cache = new Map()
        return (...args) => {
          const key = JSON.stringify(args)
          if (cache.has(key)) return cache.get(key)
          const result = fn(...args)
          cache.set(key, result)
          return result
        }
      }

      let callCount = 0

      const add = memoize((a, b) => {
        callCount += 1
        return a + b
      })

      const fibonacci = memoize((n) => {
        if (n <= 1) return n
        return fibonacci(n - 1) + fibonacci(n - 2)
      })

      // should call underlying add only twice (2 unique arg combos)
      add(1, 2)
      add(1, 2)
      add(3, 4)
      add(3, 4)
      add(1, 2)

      __result = JSON.stringify({
        add12: add(1, 2),
        add34: add(3, 4),
        callCount,
        fib10: fibonacci(10),
        fib20: fibonacci(20),
      })
    `)
    expect(JSON.parse(result)).toEqual({
      add12: 3,
      add34: 7,
      callCount: 2,
      fib10: 55,
      fib20: 6765,
    })
  })

  it('builder pattern: chaining + private + getters + tagged templates + BigInt + RegExp', () => {
    const result = compileAndRunSource(`
      function highlight(strings, ...values) {
        let result = ''
        for (let i = 0; i < strings.length; i++) {
          result += strings[i]
          if (i < values.length) {
            result += '[' + values[i] + ']'
          }
        }
        return result
      }

      class QueryBuilder {
        #table = ''
        #conditions = []
        #limit = null

        from(table) {
          this.#table = table
          return this
        }

        where(field, op, value) {
          this.#conditions.push({ field, op, value })
          return this
        }

        take(n) {
          this.#limit = n
          return this
        }

        build() {
          let sql = highlight\`SELECT * FROM \${this.#table}\`

          if (this.#conditions.length > 0) {
            const parts = this.#conditions.map(({ field, op, value }) => {
              const v = typeof value === 'string' ? "'" + value + "'" : String(value)
              return field + ' ' + op + ' ' + v
            })
            sql += ' WHERE ' + parts.join(' AND ')
          }

          if (this.#limit !== null) {
            sql += ' LIMIT ' + this.#limit
          }
          return sql
        }
      }

      const query = new QueryBuilder()
        .from('users')
        .where('age', '>', 18)
        .where('name', '=', 'alice')
        .take(10)
        .build()

      // BigInt check
      const big = 100n + 200n
      const bigStr = String(big)

      // RegExp check
      const re = /^SELECT \\* FROM/
      const matches = re.test(query)

      __result = JSON.stringify({
        query,
        matches,
        bigStr,
      })
    `)
    const parsed = JSON.parse(result)
    expect(parsed.query).toBe("SELECT * FROM [users] WHERE age > 18 AND name = 'alice' LIMIT 10")
    expect(parsed.matches).toBe(true)
    expect(parsed.bigStr).toBe('300')
  })

  it('async iteration: async generator + for-await-of + try/catch + Promise + class', async () => {
    const promise = compileAndRunSource(`
      class AsyncQueue {
        #items = []

        enqueue(item) {
          this.#items.push(item)
        }

        async *consume() {
          while (this.#items.length > 0) {
            var item = this.#items.shift()
            var processed = await Promise.resolve(item * 2)
            yield processed
          }
        }
      }

      async function main() {
        var queue = new AsyncQueue()
        queue.enqueue(1)
        queue.enqueue(2)
        queue.enqueue(3)

        var results = []

        for await (var value of queue.consume()) {
          results.push(value)
        }

        return results.join(',')
      }

      __result = main()
    `)
    await expect(promise).resolves.toBe('2,4,6')
  })

  it('complex destructuring: nested + defaults + computed + rest + swap + alias', () => {
    const result = compileAndRunSource(`
      const data = {
        user: {
          name: 'Alice',
          age: 30,
          address: {
            city: 'Shanghai',
            zip: '200000',
          },
          scores: [95, 88, 72, 100],
          metadata: undefined,
        },
        timestamp: 1234567890,
      }

      // deeply nested destructuring with defaults and aliases
      const {
        user: {
          name: userName,
          age,
          address: { city, zip: zipCode },
          scores: [first, second, ...restScores],
          metadata: meta = 'default_meta',
        },
        timestamp,
        extra = 'no_extra',
      } = data

      // array swap via destructuring
      let a = 'hello'
      let b = 'world';
      [b, a] = [a, b]

      // function parameter destructuring
      function summarize({ name, scores }, ...tags) {
        const avg = scores.reduce((s, v) => s + v, 0) / scores.length
        return name + ':' + avg + ':' + tags.join(',')
      }

      const summary = summarize(
        { name: 'Bob', scores: [80, 90, 100] },
        'math', 'science'
      )

      __result = JSON.stringify({
        userName, age, city, zipCode,
        first, second, restScores,
        meta, timestamp, extra,
        a, b, summary,
      })
    `)
    expect(JSON.parse(result)).toEqual({
      userName: 'Alice',
      age: 30,
      city: 'Shanghai',
      zipCode: '200000',
      first: 95,
      second: 88,
      restScores: [72, 100],
      meta: 'default_meta',
      timestamp: 1234567890,
      extra: 'no_extra',
      a: 'world',
      b: 'hello',
      summary: 'Bob:90:math,science',
    })
  })

})
