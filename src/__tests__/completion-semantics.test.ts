import * as vm from 'node:vm'
import { describe, expect, it } from 'vitest'
import { compileSource } from '../core'
import { expectEquivalent } from './differential'

async function equivalentAsync(source: string) {
  const native = vm.createContext({}), compiled = vm.createContext({})
  vm.runInContext(source, native, { timeout: 1000 })
  vm.runInContext(compileSource(source).code, compiled, { timeout: 1000 })
  expect(structuredClone(await compiled.__result)).toStrictEqual(structuredClone(await native.__result))
}

describe('external generator completions', () => {
  for (const asynchronous of [false, true]) {
    const prefix = asynchronous ? 'async function*' : 'function*'
    for (const action of ['return', 'throw']) {
      for (const override of ['break', 'continue', 'return', 'throw']) {
        it(`${prefix} finally ${override} replaces external ${action}`, async () => {
          await equivalentAsync(`
            const events = [];
            ${prefix} work() {
              outer: for (let i = 0; i < 2; i++) {
                try { yield i; }
                finally {
                  events.push(i);
                  if (i === 0) ${override === 'break' ? 'break outer;' : override === 'continue' ? 'continue outer;' : override === 'return' ? "return 'replacement';" : "throw new RangeError('replacement');"}
                }
              }
              return 'after';
            }
            globalThis.__result = (async () => {
              const iterator = work(); const results = [await iterator.next()];
              try { results.push(await iterator.${action}('external')); results.push(await iterator.next()); }
              catch (error) { results.push(error.name || error); }
              results.push(await iterator.next()); return [results, events];
            })();
          `)
        })
      }
    }

    it(`${prefix} preserves pending return through nested yielding finally blocks`, async () => {
      await equivalentAsync(`
        ${prefix} work() {
          try { try { yield 1; } finally { yield 2; } }
          finally { yield 3; }
        }
        globalThis.__result = (async () => {
          const i = work(); return [await i.next(), await i.return(9), await i.next(), await i.next(), await i.next()];
        })();
      `)
    })

    it(`${prefix} a second return replaces a return suspended in finally`, async () => {
      await equivalentAsync(`
        const events = [];
        ${prefix} work() { try { try { yield 1; } finally { yield 2; events.push('skipped'); } }
          finally { events.push('outer'); } }
        globalThis.__result = (async () => {
          const i = work(); return [[await i.next(), await i.return(9), await i.return(7), await i.next()], events];
        })();
      `)
    })

    it(`${prefix} a thrown resume in finally propagates through the outer catch`, async () => {
      await equivalentAsync(`
        ${prefix} work() { try { try { yield 1; } finally { yield 2; } }
          catch (error) { yield error; return 'caught'; } }
        globalThis.__result = (async () => {
          const i = work(); return [await i.next(), await i.return(9), await i.throw('injected'), await i.next()];
        })();
      `)
    })

    it(`${prefix} delegation forwards sent values, throw, and a yielding return`, async () => {
      await equivalentAsync(`
        ${prefix} inner() { try { const sent = yield 1; yield sent; }
          catch (error) { yield error; } finally { yield 'cleanup'; } return 'inner-end'; }
        ${prefix} outer() { const result = yield* inner(); yield result; return 'outer-end'; }
        globalThis.__result = (async () => {
          const a = outer(); const normal = [await a.next(), await a.next(4), await a.throw('caught'), await a.next(), await a.next(), await a.next()];
          const b = outer(); const abrupt = [await b.next(), await b.return(9), await b.next(), await b.next()];
          return [normal, abrupt];
        })();
      `)
    })

    it(`${prefix} return closes an active for-of iterator exactly once`, async () => {
      await equivalentAsync(`
        const events = [];
        function* values() { try { yield 1; yield 2; } finally { events.push('closed'); } }
        ${prefix} work() { try { for (const x of values()) { yield x; } } finally { events.push('finally'); } }
        globalThis.__result = (async () => {
          const i = work(); return [[await i.next(), await i.return(9), await i.next()], events];
        })();
      `)
    })

    it(`${prefix} does not execute the body on return or throw before start`, async () => {
      await equivalentAsync(`
        const events = []; ${prefix} work() { events.push('started'); yield 1; }
        globalThis.__result = (async () => {
          const a = work(), b = work(); const results = [await a.return(7), await a.next()];
          try { await b.throw('early'); } catch (error) { results.push(error); }
          results.push(await b.next()); return [results, events];
        })();
      `)
    })
  }

  it('yield* closes an iterator missing throw before reporting TypeError', () => {
    expectEquivalent(`
      const events = [];
      const values = { [Symbol.iterator]() { return this; }, next() { return { value: 1, done: false }; },
        return() { events.push('closed'); return {}; } };
      function* work() { try { yield* values; } catch (error) { return error.name; } }
      const i = work(); globalThis.__result = [i.next(), i.throw('injected'), events];
    `)
  })

  it('preserves generator brands, prototypes, and post-completion throw/return', () => {
    expectEquivalent(`
      function* work() { yield 1; return 2; }
      const i = work(); const prototype = Object.getPrototypeOf(Object.getPrototypeOf(i));
      const result = [Object.prototype.toString.call(i), i[Symbol.iterator]() === i,
        prototype.next.call(i), prototype.return.call(i, 7), i.return(8), i.next()];
      try { i.throw('late'); } catch (error) { result.push(error); }
      globalThis.__result = result;
    `)
  })
})

describe('iteration and statement label sets', () => {
  for (const loop of ['for (const x of [0, 1, 2])', 'for (const x in { 0: 1, 1: 1, 2: 1 })', 'for (let x = 0; x < 3; x++)']) {
    it(`retains all labels on ${loop}`, () => {
      expectEquivalent(`
        const values = [];
        outer: middle: inner: ${loop} {
          try { values.push(Number(x)); if (Number(x) === 0) continue outer; if (Number(x) === 1) continue middle; break inner; }
          finally { values.push('finally'); }
        }
        globalThis.__result = values;
      `)
    })
  }

  it('preserves multiple labels on while and do loops', () => {
    expectEquivalent(`
      let i = 0; const values = [];
      a: b: while (i < 3) { i++; if (i === 1) continue a; values.push(i); break b; }
      c: d: do { i++; if (i === 3) continue c; values.push(i); break d; } while (i < 5);
      globalThis.__result = values;
    `)
  })

  it('supports labels on arbitrary statements and nested labeled blocks', () => {
    expectEquivalent(`
      const values = [];
      outer: inner: if (true) { try { values.push(1); break outer; } finally { values.push(2); } values.push(3); }
      one: two: { values.push(4); break two; values.push(5); }
      globalThis.__result = values;
    `)
  })

  it('closes only the exited iterator when continuing a labeled outer for-of', () => {
    expectEquivalent(`
      const events = []; function* inner() { try { yield 1; yield 2; } finally { events.push('close'); } }
      outer: alias: for (const x of [1, 2]) { for (const y of inner()) { events.push([x, y]); continue alias; } }
      globalThis.__result = events;
    `)
  })
})

describe('delegation protocol edge cases', () => {
  for (const asynchronous of [false, true]) {
    const prefix = asynchronous ? 'async function*' : 'function*'
    for (const method of ['next', 'return', 'throw']) {
      it(`${prefix} rejects nonobject results from delegated ${method}`, async () => {
        await equivalentAsync(`
          const events = [];
          const iterable = { [Symbol.iterator]() { return this; },
            next() { return ${method === 'next' ? '4' : '{value: 1, done: false}'}; },
            return() { events.push('return'); return 4; },
            throw() { events.push('throw'); return 4; } };
          ${prefix} work() { try { yield* iterable; } finally { events.push('finally'); } }
          globalThis.__result = (async () => {
            const i = work(); const results = [];
            try { results.push(await i.next()); ${method === 'next' ? '' : `results.push(await i.${method}(9));`} }
            catch (error) { results.push(error.name); }
            return [results, events];
          })();
        `)
      })
    }

    it(`${prefix} forwards return without a delegate return method`, async () => {
      await equivalentAsync(`
        const iterable = { [Symbol.iterator]() { return this; }, next() { return { value: 1, done: false }; } };
        ${prefix} work() { yield* iterable; return 'unreachable'; }
        globalThis.__result = (async () => { const i = work(); return [await i.next(), await i.return(9)]; })();
      `)
    })
  }

  it('serializes async generator requests and awaits return values through yielding cleanup', async () => {
    await equivalentAsync(`
      async function* work() { try { yield Promise.resolve(1); } finally { yield Promise.resolve(2); } }
      globalThis.__result = (async () => {
        const i = work();
        const first = i.next(), returned = i.return(Promise.resolve(9)), cleanup = i.next(), last = i.next();
        return Promise.all([first, returned, cleanup, last]);
      })();
    `)
  })

  it('does not expose private completion records to generator code', () => {
    expectEquivalent(`
      function* work() { const sent = yield 1; return sent; }
      const a = work(); a.next();
      const value = { type: 'throw', value: 3 };
      globalThis.__result = [a.next(value), value];
    `)
  })

  it('does not require the mutable global Symbol binding to create generators', () => {
    expectEquivalent(`
      function* work() { yield 1; }
      globalThis.Symbol = undefined;
      globalThis.__result = work().next();
    `)
  })
})


describe('unlabeled breaks inside labeled statements', () => {
  it('breaks the nearest loop instead of the labeled block', () => {
    expectEquivalent(`
      const events = [];
      for (let i = 0; i < 3; i++) {
        named: { try { events.push(i); break; } finally { events.push('finally'); } }
        events.push('unreachable');
      }
      globalThis.__result = events;
    `)
  })

  it('breaks the nearest switch without leaving an enclosing labeled loop', () => {
    expectEquivalent(`
      const events = [];
      outer: alias: for (const value of [1, 2]) {
        switch (value) { case 1: named: { events.push('one'); break; } default: events.push('two'); }
        events.push(value);
      }
      globalThis.__result = events;
    `)
  })
})

describe('delegated iterator result forwarding', () => {
  for (const action of ['next', 'throw', 'return']) {
    it(`forwards the original unfinished result from delegated ${action} without reading value`, () => {
      expectEquivalent(`
        const events = [];
        const result = { done: false, get value() { events.push('value'); throw new Error('must stay lazy'); } };
        const iterable = { [Symbol.iterator]() { return this; }, next() { events.push('next'); return result; },
          throw(value) { events.push(['throw', value]); return result; },
          return(value) { events.push(['return', value]); return result; } };
        function* work() { yield* iterable; }
        const i = work(); const first = i.next();
        const second = i.${action}(7);
        globalThis.__result = [first === result, second === result, events];
      `)
    })
  }

  it('checks a throwing done getter before reading the delegated value', () => {
    expectEquivalent(`
      const events = [];
      const iterable = { [Symbol.iterator]() { return this; }, next() { return {
        get done() { events.push('done'); throw new RangeError('done'); },
        get value() { events.push('value'); return 1; }
      }; } };
      function* work() { try { yield* iterable; } catch (error) { return error.name; } }
      globalThis.__result = [work().next(), events];
    `)
  })

  it('reads a completed result value after its done getter', () => {
    expectEquivalent(`
      const events = [];
      const iterable = { [Symbol.iterator]() { return this; }, next() { return {
        get done() { events.push('done'); return true; },
        get value() { events.push('value'); return 3; }
      }; } };
      function* work() { return yield* iterable; }
      globalThis.__result = [work().next(), events];
    `)
  })
})
