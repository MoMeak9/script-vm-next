const assert = require('node:assert/strict')
const { compileAndRunSource } = require('./04-emit-bytecode-and-run')
const { runCounterDemo } = require('./05-closure-runtime')
const { runThisDemo } = require('./05-this-and-arguments')

function testArithmeticAndIf() {
  const result = compileAndRunSource(`
var x = 40 + 2;
if (x > 20) {
  __result = x;
} else {
  __result = 0;
}
`)

  assert.equal(result, 42)
}

function testClosure() {
  assert.deepEqual(runCounterDemo(), [1, 2, 3])
}

function testThisAndArguments() {
  assert.deepEqual(runThisDemo(), ['box', 3])
}

function runAllTests() {
  testArithmeticAndIf()
  testClosure()
  testThisAndArguments()
  console.log('All tutorial JSVM tests passed.')
}

if (require.main === module) {
  runAllTests()
}

module.exports = {
  runAllTests,
}
