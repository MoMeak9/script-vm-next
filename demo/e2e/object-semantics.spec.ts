import { expect, test } from '@playwright/test';

test('the production worker preserves enhanced object literal semantics', async ({ page }) => {
  await page.goto('./');
  const source = page.locator('#source-editor .cm-content');
  await expect(source).toBeVisible();
  await expect(page.locator('#compile-button')).toBeEnabled();
  await source.fill(`
    function create(Object, Reflect) {
      return {
        __proto__: { read() { return this.value; } },
        ['__proto__']: 'own property',
        value: 7,
        read() { return super.read(); }
      };
    }
    const object = create(null, null);
    const detached = { value: 9, read: object.read };
    console.log('object compatibility', object.read(), detached.read(), object.__proto__, object.read.name);
    Object.setPrototypeOf(object, { read() { return this.value + 10; } });
    console.log('dynamic super', detached.read());
    try { new object.read(); } catch (error) { console.log('method constructor', error.name); }
  `);
  await page.locator('#compile-button').click();
  await expect(page.locator('#run-button')).toBeEnabled();
  await expect(page.locator('#error-panel')).toBeHidden();
  await page.locator('#run-button').click();
  await expect(page.locator('#run-status')).toHaveAttribute('data-status', 'completed');
  const logs = page.locator('#console-output');
  await expect(logs).toContainText('object compatibility 7 9 own property read');
  await expect(logs).toContainText('dynamic super 19');
  await expect(logs).toContainText('method constructor TypeError');
});
