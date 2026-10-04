import { expect, test } from '@playwright/test';

test('browser compiler preserves strict mutations and generator finally completion overrides', async ({ page }) => {
  await page.goto('./');
  const source = page.locator('#source-editor .cm-content');
  await expect(source).toBeVisible();
  await expect(page.locator('#compile-button')).toBeEnabled();
  await source.fill(`
    function strictWrite() { 'use strict'; const object = Object.freeze({ x: 1 });
      try { object.x = 2; } catch (error) { return error.name; } }
    function strictDelete() { 'use strict'; const object = Object.freeze({ x: 1 });
      try { delete object.x; } catch (error) { return error.name; } }
    function sloppyWrite() { const object = Object.freeze({ x: 1 }); object.x = 2; return object.x; }
    function* work() { outer: alias: for (const value of [1, 2]) {
      try { yield value; } finally { break outer; }
    } return 'after-finally'; }
    const iterator = work(); iterator.next();
    console.log('strict-write', strictWrite());
    console.log('strict-delete', strictDelete());
    console.log('sloppy-write', sloppyWrite());
    console.log('generator', iterator.return('discarded').value);
  `);
  await page.locator('#compile-button').click();
  await expect(page.locator('#run-button')).toBeEnabled();
  await expect(page.locator('#error-panel')).toBeHidden();
  await page.locator('#run-button').click();
  await expect(page.locator('#run-status')).toHaveAttribute('data-status', 'completed');
  for (const line of ['strict-write TypeError', 'strict-delete TypeError', 'sloppy-write 1', 'generator after-finally']) {
    await expect(page.locator('#console-output')).toContainText(line);
  }
});
