/**
 * 阶段六 示例 1：测试模板
 *
 * 展示如何使用 compileAndRunSource 编写端到端测试。
 * 可以直接作为模板复制使用。
 *
 * 运行方式：npx vitest run docs/examples/06-testing/01-test-template.test.mjs
 * (需要先 pnpm build)
 */
import { describe, expect, it } from 'vitest'
import { compileAndRunSource } from '../../../src/__tests__/helpers'

describe('ScriptVM 教程测试示例', () => {
  // ═══════════════════════════════════════════════
  // 基础语法
  // ═══════════════════════════════════════════════
  describe('基础语法', () => {
    it('算术运算', () => {
      expect(compileAndRunSource('__result = 40 + 2')).toBe(42)
    })

    it('字符串拼接', () => {
      expect(compileAndRunSource(`
        var name = "World";
        __result = "Hello, " + name + "!";
      `)).toBe('Hello, World!')
    })

    it('比较运算', () => {
      expect(compileAndRunSource(`
        __result = [1 < 2, 3 === 3, "a" !== "b"];
      `)).toEqual([true, true, true])
    })

    it('typeof 运算符', () => {
      expect(compileAndRunSource(`
        __result = [typeof 42, typeof "hello", typeof true, typeof undefined];
      `)).toEqual(['number', 'string', 'boolean', 'undefined'])
    })
  })

  // ═══════════════════════════════════════════════
  // 控制流
  // ═══════════════════════════════════════════════
  describe('控制流', () => {
    it('if-else', () => {
      expect(compileAndRunSource(`
        var x = 15;
        if (x > 10) {
          __result = "big";
        } else {
          __result = "small";
        }
      `)).toBe('big')
    })

    it('三元表达式', () => {
      expect(compileAndRunSource(`
        var x = 5;
        __result = x > 3 ? "yes" : "no";
      `)).toBe('yes')
    })

    it('while 循环', () => {
      expect(compileAndRunSource(`
        var i = 1;
        var result = 1;
        while (i <= 5) {
          result = result * i;
          i++;
        }
        __result = result;
      `)).toBe(120)
    })

    it('for 循环', () => {
      expect(compileAndRunSource(`
        var sum = 0;
        for (var i = 1; i <= 100; i++) {
          sum += i;
        }
        __result = sum;
      `)).toBe(5050)
    })

    it('do-while 循环', () => {
      expect(compileAndRunSource(`
        var i = 0;
        do { i++; } while (i < 5);
        __result = i;
      `)).toBe(5)
    })

    it('switch-case', () => {
      expect(compileAndRunSource(`
        var x = 2;
        switch (x) {
          case 1: __result = "one"; break;
          case 2: __result = "two"; break;
          case 3: __result = "three"; break;
          default: __result = "other";
        }
      `)).toBe('two')
    })
  })

  // ═══════════════════════════════════════════════
  // 函数与闭包
  // ═══════════════════════════════════════════════
  describe('函数与闭包', () => {
    it('函数声明与调用', () => {
      expect(compileAndRunSource(`
        function multiply(a, b) { return a * b; }
        __result = multiply(6, 7);
      `)).toBe(42)
    })

    it('函数表达式', () => {
      expect(compileAndRunSource(`
        var square = function(n) { return n * n; };
        __result = square(8);
      `)).toBe(64)
    })

    it('递归', () => {
      expect(compileAndRunSource(`
        function fibonacci(n) {
          if (n <= 1) return n;
          return fibonacci(n - 1) + fibonacci(n - 2);
        }
        __result = fibonacci(10);
      `)).toBe(55)
    })

    it('闭包计数器', () => {
      expect(compileAndRunSource(`
        function counter() {
          var n = 0;
          return function() { n++; return n; };
        }
        var c = counter();
        c(); c(); c();
        __result = c();
      `)).toBe(4)
    })

    it('高阶函数', () => {
      expect(compileAndRunSource(`
        function map(arr, fn) {
          var result = [];
          for (var i = 0; i < arr.length; i++) {
            result.push(fn(arr[i]));
          }
          return result;
        }
        __result = map([1, 2, 3], function(x) { return x * 2; });
      `)).toEqual([2, 4, 6])
    })
  })

  // ═══════════════════════════════════════════════
  // this 绑定
  // ═══════════════════════════════════════════════
  describe('this 绑定', () => {
    it('方法调用中的 this', () => {
      expect(compileAndRunSource(`
        var obj = {
          value: 100,
          getValue: function() { return this.value; }
        };
        __result = obj.getValue();
      `)).toBe(100)
    })

    it('new 构造函数', () => {
      expect(compileAndRunSource(`
        function Point(x, y) { this.x = x; this.y = y; }
        var p = new Point(3, 4);
        __result = p.x + p.y;
      `)).toBe(7)
    })
  })

  // ═══════════════════════════════════════════════
  // 错误处理
  // ═══════════════════════════════════════════════
  describe('错误处理', () => {
    it('try-catch', () => {
      expect(compileAndRunSource(`
        var msg;
        try {
          throw "oops";
        } catch (e) {
          msg = "caught: " + e;
        }
        __result = msg;
      `)).toBe('caught: oops')
    })

    it('try-finally', () => {
      expect(compileAndRunSource(`
        var log = [];
        try {
          log.push("try");
        } finally {
          log.push("finally");
        }
        __result = log;
      `)).toEqual(['try', 'finally'])
    })
  })
})
