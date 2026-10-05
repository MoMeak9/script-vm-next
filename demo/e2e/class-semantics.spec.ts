import { expect, test } from '@playwright/test';

test('class lexical keys, inferred names and dynamic inheritance run in the browser VM', async ({ page }) => {
  await page.goto('./');
  const editor = page.locator('#source-editor .cm-content');
  await expect(editor).toBeVisible();
  await editor.fill(`
    class Original { constructor() { this.value = 'old'; } }
    class Replacement { constructor() { this.value = 'new'; this.target = new.target.name; } }
    class Derived extends Original { constructor() { super(); } }
    Object.setPrototypeOf(Derived, Replacement);
    function factory(key) {
      return (() => class { [this.prefix + arguments[0]]() { return 42; } })();
    }
    const Example = factory.call({ prefix: 'run:' }, 'key');
    const named = { [Symbol.for('Demo')]: class {} };
    const instance = new Derived();
    console.log('class-compatibility', instance.value, instance.target,
      new Example()['run:key'](), named[Symbol.for('Demo')].name);
  `);
  await page.locator('#compile-button').click();
  await expect(page.locator('#run-button')).toBeEnabled();
  await expect(page.locator('#error-panel')).toBeHidden();
  await page.locator('#run-button').click();
  await expect(page.locator('#run-status')).toHaveAttribute('data-status', 'completed');
  await expect(page.locator('#console-output')).toContainText('class-compatibility new Derived 42 [Demo]');
});
