# Pinned ES2015 Test262 baseline

This repository runs a **selected script-only baseline**, not the full Test262 suite. Passing this baseline does not establish complete ES2015 compatibility. The native-versus-VM regression tests, package consumers, and browser tests remain separate checks.

The baseline contains **219 upstream files and 428 execution variants**. CI runs every selected variant on Node.js **20, 22, and 24**. There are **no allowed failures or skips**. A failed assertion, incorrect negative-test phase, timeout, integrity mismatch, or unsupported execution requirement fails the command.

```sh
pnpm build
pnpm test:test262
```

`test:test262` first tests the runner's failure paths, then executes the corpus. The command uses local files only and never downloads tests. It writes detailed results, declared features, mode, failure engine, and revision to `artifacts/test262/report.json`; CI uploads a separate report for each Node version, including failed runs when a report was produced.

## Provenance and integrity

- Upstream: [tc39/test262](https://github.com/tc39/test262).
- Pinned revision: [`7ab7fafa0003f73fc85c1b95d88094d33f7eb8bd`](https://github.com/tc39/test262/tree/7ab7fafa0003f73fc85c1b95d88094d33f7eb8bd).
- Exact paths and SHA-256 digests: [`vendor/test262/manifest.json`](../vendor/test262/manifest.json).
- Original BSD license: [`vendor/test262/LICENSE`](../vendor/test262/LICENSE).
- Tests and harness files are copied **without modification**, retaining upstream copyright notices. The project's own license declaration does not replace the Test262 license.

The runner verifies every vendored file before starting and refuses unpinned harness includes or paths outside the corpus. Vendored tests are not included in the published npm tarball. Git review protects the manifest; the checksums detect accidental edits, not a malicious change to both a fixture and its manifest.

## Selected scope

Selection is explicit in the manifest; the runner does not discover or silently filter tests based on what passes. The scope covers the following ES2015 syntax and behavior, including applicable parse/runtime negative cases and both strict and non-strict execution unless upstream flags specify otherwise.

| Upstream directory | Files | Selected behavior |
| --- | ---: | --- |
| `language/literals/numeric` | 10 | Binary/octal literals and invalid forms |
| `language/expressions/template-literal` | 54 | Substitution, coercion, evaluation order, escapes, syntax errors |
| `language/expressions/tagged-template` | 20 | Template identity, argument evaluation, call context, object descriptors |
| `language/expressions/arrow-function` | 45 | Lexical bindings, defaults, parameter/body scopes, syntax restrictions |
| `language/expressions/new.target` | 13 | Ordinary/reflective construction, calls, super, tagged invocation |
| `language/rest-parameters` | 11 | Arrays, patterns, arity, arguments separation, invalid placement |
| `language/expressions/array` | 22 | Single/multiple spreads, iteration and abrupt completions |
| `language/expressions/call` | 22 | Single/multiple argument spreads, iteration and abrupt completions |
| `language/statements/let` | 12 | Lexical initialization and TDZ access |
| `language/statements/const` | 10 | Lexical initialization and TDZ access |

Post-ES2015 features, direct `eval`, `with`, host `$262` hooks, async tests, modules, agents, proper tail calls, and the rest of the upstream suite are outside this baseline. Browser Test262 execution is also outside this runner's scope. Existing browser regression tests still run in CI.

### Initial audit and known exclusions

A broader audit against compiler base `c634222` evaluated **231 files / 451 variants**: **429 passed and 22 failed**, with no skips or timeouts. These results must not be represented as complete passing coverage. Twelve files were deliberately left outside this independent baseline while their semantic fixes are reviewed separately:

| Exact upstream path(s), relative to `test/language/` | Failing modes | Observed mismatch |
| --- | --- | --- |
| `statements/const/fn-name-arrow.js`, `fn-name-class.js`, `fn-name-cover.js`, `fn-name-fn.js`, `fn-name-gen.js` | Sloppy and strict for each file: 10 failures | Anonymous definition name inference/descriptor value |
| `statements/let/fn-name-arrow.js`, `fn-name-class.js`, `fn-name-cover.js`, `fn-name-fn.js`, `fn-name-gen.js` | Sloppy and strict for each file: 10 failures | Anonymous definition name inference/descriptor value |
| `statements/let/block-local-closure-set-before-initialization.js` | Sloppy: 1 failure; strict passed | A block function writing a lexical binding before initialization did not throw `ReferenceError` |
| `expressions/tagged-template/template-object-frozen-strict.js` | Strict: 1 failure | Writing a frozen template object did not throw `TypeError` |

The manifest records every full pending path in `selection.pendingSemanticFixes`. Removing the twelve files removes 23 variants, including the passing strict block-function variant, leaving the selected 428 variants. These omissions are **known unsupported behavior at that base**, not a general reason to suppress new failures. Add the cases to the corpus when the corresponding fixes land and update these counts and the pending list in the same review.

## Execution model

1. Read frontmatter execution fields: `flags`, `includes`, `features`, and `negative.phase/type`. Descriptions and specification quotations are not executed. The parser accepts scalar execution values, inline lists, block lists, and the conventional negative-test mapping used by the pinned corpus; malformed or ambiguous execution metadata fails closed.
2. Schedule sloppy/strict variants according to Test262 flags. `raw` uses the source without harness or an injected strict directive. Unsupported module/async/agent requirements are reported explicitly as skips and make the baseline command fail; they are never counted as passes. Feature labels are recorded, not used to silently suppress cases.
3. Load the unmodified official `sta.js`, `assert.js`, and requested harness includes into a fresh Node VM realm. Harness failures always fail the case and cannot satisfy runtime-negative expectations.
4. Run the native source as an oracle/harness sanity check, then compile the **test program** through the built `compileSource` public API and execute the emitted VM program in another fresh realm. Harness helpers stay native, as they do in an ordinary Test262 host; the actual tested syntax runs through the compiler.
5. Parse/early negatives require a parse-stage `SYNTAX_ERROR` with the expected underlying constructor name. A later unsupported-feature/compiler error cannot pass as a parse negative. Runtime negatives require the exact expected exception constructor from the test realm; matching an error's text or `name` is insufficient. Invalid emitted JavaScript cannot satisfy a runtime-negative expectation.
6. Enforce a one-second execution limit per script and a ten-second wall-clock deadline per variant, including compilation. Two reusable workers provide isolation from compiler stalls. Timed-out/crashed workers are terminated and replaced so the remaining results are still reported. Each variant gets fresh execution realms; no test globals are shared.

Node VM contexts and workers are test isolation/resource controls, not a security sandbox for arbitrary untrusted tests. Only the reviewed, pinned upstream corpus is executed.

The runner's own tests exercise assertion failure, false parse-negative matches, missing/wrong runtime exceptions, same-name fake errors, harness errors, invalid emitted syntax, strict modes, metadata conflicts, fixture tampering, missing includes, timeouts, worker crashes/reuse, realm separation, and honest result accounting.

## Updating the corpus

1. Check out the exact upstream revision in a separate directory and review new tests and their feature requirements. Keep additions relevant to the supported script API; module testing requires a separate file-API harness.
2. Copy the desired tests and their harness includes byte-for-byte, preserving upstream paths, notices, and license. Add their SHA-256 digests to the manifest. A revision update must refresh all selected files and the license from that revision, rather than mixing revisions under one label.
3. Run `pnpm build && pnpm test:test262` on the supported Node matrix. Inspect both native and VM failures. Do not convert failing assertions into skips or change upstream expectations to make CI pass.
4. Update the scope table, counts, pending paths, and provenance together. A wider selection gives more evidence; it does not by itself justify a full ES2015 compatibility claim.
