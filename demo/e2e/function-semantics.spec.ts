import { expect, test } from '@playwright/test';

test('function environments and arguments run through the browser compiler worker', async ({ page }) => {
  await page.goto('./');
  const editor = page.locator('#source-editor .cm-content');
  await expect(editor).toBeVisible();
  await expect(page.locator('#compile-button')).toBeEnabled();
  await editor.fill(`
    const factorial = function self(n) { return n > 1 ? n * self(n - 1) : 1; };
    function scoped() {
      'use strict';
      const values = [];
      try { values.push(f()); function f() { return 7; } }
      finally { values.push(typeof f); }
      return values.join(',');
    }
    function mapped(a) {
      a = 2;
      const first = arguments[0];
      Object.defineProperty(arguments, '0', {value: 3, writable: false});
      const second = a;
      a = 4;
      return [first, second, arguments[0], a, arguments.callee === mapped].join(',');
    }
    const arrow = () => 1;
    let assigned; assigned = function() {};
    console.log('self', factorial(5));
    console.log('scope', scoped());
    console.log('arguments', mapped(1));
    console.log('names', arrow.name, assigned.name);
  `);
  await page.locator('#compile-button').click();
  await expect(page.locator('#error-panel')).toBeHidden();
  await expect(page.locator('#run-button')).toBeEnabled();
  await page.locator('#run-button').click();
  await expect(page.locator('#run-status')).toHaveAttribute('data-status', 'completed');
  const logs = page.locator('#console-output');
  await expect(logs).toContainText('self 120');
  await expect(logs).toContainText('scope 7,undefined');
  await expect(logs).toContainText('arguments 2,3,3,4,true');
  await expect(logs).toContainText('names arrow assigned');
});
