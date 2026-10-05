import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

async function compile(page: Page, source: string): Promise<void> {
  await page.locator('#source-editor .cm-content').fill(source);
  await page.locator('#compile-button').click();
  await expect(page.locator('#run-button')).toBeEnabled();
  await expect(page.locator('#error-panel')).toBeHidden();
}

test('a console-only script downloads a runtime containing only its required capabilities', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#compile-button')).toBeEnabled();
  await compile(page, 'console.log("hello");');

  await expect(page.locator('#runtime-details')).toBeVisible();
  await expect(page.locator('#runtime-summary')).toHaveText(' · 6 类指令');
  await page.locator('#runtime-details summary').click();
  await expect(page.locator('#runtime-modes')).toHaveText('同步');

  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-button').click();
  const downloaded = await downloadPromise;
  const downloadedPath = await downloaded.path();
  expect(downloadedPath).not.toBeNull();
  const code = await readFile(downloadedPath!, 'utf8');
  expect(code).toContain('executeSync');
  for (const unused of ['executeAsync', 'executeGenerator', 'executeAsyncGenerator', 'getTemplateObject', 'iteratorStart', 'objectDefineMethod']) {
    expect(code).not.toContain(unused);
  }
  const bytes = Buffer.byteLength(code, 'utf8');
  const formattedBytes = bytes < 1024 ? `${bytes.toLocaleString()} B` : `${(bytes / 1024).toFixed(1)} KiB`;
  await expect(page.locator('#metric-size')).toHaveText(formattedBytes);
  expect(bytes).toBeLessThan(30_000);

  await page.locator('#run-button').click();
  await expect(page.locator('#run-status')).toHaveAttribute('data-status', 'completed');
  await expect(page.locator('#console-output')).toContainText('hello');
});

test('runtime details track the current source and include asynchronous generators on demand', async ({ page }) => {
  await page.goto('./');
  await expect(page.locator('#compile-button')).toBeEnabled();
  await compile(page, `
    async function* values() { yield 42; }
    values().next().then(result => console.log('generated', result.value));
  `);
  await page.locator('#runtime-details summary').click();
  await expect(page.locator('#runtime-modes')).toHaveText('同步、异步生成器');
  await page.locator('#run-button').click();
  await expect(page.locator('#run-status')).toHaveAttribute('data-status', 'completed');
  await expect(page.locator('#console-output')).toContainText('generated 42');

  await page.locator('#source-editor .cm-content').fill('const broken = ;');
  await expect(page.locator('#runtime-details')).toBeHidden();
  await page.locator('#compile-button').click();
  await expect(page.locator('#error-panel')).toBeVisible();
  await expect(page.locator('#runtime-details')).toBeHidden();

  await compile(page, 'console.log("recovered");');
  await expect(page.locator('#runtime-details')).toBeVisible();
  await expect(page.locator('#runtime-summary')).toHaveText(' · 6 类指令');
  await expect(page.locator('#runtime-modes')).toHaveText('同步');
});
