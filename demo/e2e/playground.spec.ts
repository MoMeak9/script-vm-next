import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

const sourceEditor = (page: Page) => page.locator('#source-editor .cm-content');
const logs = (page: Page) => page.locator('#console-output');

async function openPlayground(page: Page): Promise<void> {
  await page.goto('./');
  await expect(sourceEditor(page)).toBeVisible();
  await expect(page.locator('#compile-button')).toBeEnabled();
}

async function editSource(page: Page, source: string): Promise<void> {
  await sourceEditor(page).fill(source);
}

async function compile(page: Page, source?: string): Promise<void> {
  if (source !== undefined) await editSource(page, source);
  await page.locator('#compile-button').click();
  await expect(page.locator('#run-button')).toBeEnabled();
  await expect(page.locator('#error-panel')).toBeHidden();
}

async function run(page: Page): Promise<void> {
  await page.locator('#run-button').click();
  await expect(page.locator('#run-status')).toHaveAttribute('data-status', 'completed');
}

test('build assets load under the Pages subpath and the default example runs', async ({ page }, testInfo) => {
  const failures: string[] = [];
  const loadedUrls: string[] = [];
  page.on('response', response => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
    loadedUrls.push(response.url());
  });
  page.on('pageerror', error => failures.push(error.message));

  await openPlayground(page);
  await expect(page.locator('#run-button')).toBeEnabled();
  await expect(page.locator('#run-status-text')).toHaveText('尚未运行');
  await expect(logs(page)).not.toContainText('hello, vm: 42');
  await compile(page);
  await run(page);

  await expect(logs(page)).toContainText('hello, vm: 42');
  await expect(logs(page)).toContainText('41');
  await expect(logs(page)).toContainText('42');
  await expect(page.locator('#metric-bytecode')).not.toHaveText('—');
  await expect(page.locator('#metric-functions')).not.toHaveText('—');
  await expect(page.locator('#version-label')).toContainText(/\d+\.\d+\.\d+/);
  expect(loadedUrls.some(url => /\/script-vm-next\/assets\/compiler\.worker-.*\.js/.test(url))).toBe(true);
  expect(loadedUrls.some(url => url.endsWith('/script-vm-next/runner.html'))).toBe(true);
  expect(failures).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('playground-desktop.png'), fullPage: true });
});

for (const example of [
  { id: 'classes', output: '142' },
  { id: 'async', output: '完成 ✓' },
  { id: 'iteration', output: '9007199254740993' },
]) {
  test(`the ${example.id} example compiles and executes`, async ({ page }) => {
    await openPlayground(page);
    await page.locator('#example-select').selectOption(example.id);
    await compile(page);
    await run(page);
    await expect(logs(page)).toContainText(example.output);
  });
}

test('the ES6 compatibility example runs without caller-side transforms', async ({ page }) => {
  await openPlayground(page);
  await page.locator('#example-select').selectOption('es6-compatibility');
  await compile(page);
  await run(page);

  for (const output of [
    'Set 解构 → 1 2, 3',
    '参数作用域 → 1, 2',
    '静态继承 → 42',
    '模板对象复用 → true',
    '模板对象冻结 → true true',
  ]) {
    await expect(logs(page)).toContainText(output);
  }
});

test('syntax errors show their source location and can be corrected', async ({ page }) => {
  await openPlayground(page);
  await editSource(page, 'const valid = 1;\nconst broken = ;');
  await page.locator('#compile-button').click();
  await expect(page.locator('#error-panel')).toBeVisible();
  await expect(page.locator('#error-message')).toContainText(/playground\.js.*2|第\s*2\s*行|line\s+2/i);
  await expect(page.locator('#error-location')).toBeVisible();
  await expect(page.locator('#run-button')).toBeDisabled();
  await page.locator('#error-location').click();
  await expect(sourceEditor(page)).toBeFocused();

  await compile(page, "console.log('corrected source', 6 * 7);");
  await run(page);
  await expect(logs(page)).toContainText('corrected source 42');
});

test('editing invalidates the previous artifact; recompilation, copy, and download agree', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openPlayground(page);
  await compile(page, "console.log('first artifact');");
  await editSource(page, "console.log('updated artifact', 21 * 2);");
  await expect(page.locator('#run-button')).toBeDisabled();
  await expect(page.locator('#copy-button')).toBeDisabled();
  await compile(page);
  await run(page);
  await expect(logs(page)).toContainText('updated artifact 42');

  await page.locator('#copy-button').click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('__scriptvmRun');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#download-button').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.vm\.js$/);
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  expect(await readFile(downloadedPath!, 'utf8')).toBe(copied);
});

test('a runaway program times out and the next execution succeeds', async ({ page }) => {
  await openPlayground(page);
  await compile(page, 'while (true) {}');
  await page.locator('#run-button').click();
  await expect(page.locator('#run-status')).toHaveAttribute('data-status', 'timeout');
  await expect(page.locator('#stop-button')).toBeDisabled();
  await compile(page, "console.log('recovered after timeout');");
  await run(page);
  await expect(logs(page)).toContainText('recovered after timeout');
});

test('forged worker messages cannot report completion or bypass the execution timeout', async ({ page }) => {
  await openPlayground(page);
  await compile(page, `
    console.log('real output before forged messages');
    self.postMessage({ type: 'started' });
    self.postMessage({ type: 'log', level: 'log', text: 'forged console output' });
    self.postMessage({ type: 'completed' });
    self.postMessage({ type: 'error', message: 'forged execution error' });
    while (true) {}
  `);
  await page.locator('#run-button').click();
  await expect(logs(page)).toContainText('real output before forged messages');

  // Even a message from the correct opaque iframe must carry this run's token.
  // User code runs in its worker and cannot access the iframe window or token.
  const frame = page.frames().find(frame => frame.url().endsWith('/runner.html'));
  expect(frame).toBeDefined();
  await frame!.evaluate(() => {
    window.parent.postMessage({ type: 'completed', token: 'not-the-current-run-token' }, '*');
  });

  await expect(page.locator('#run-status')).toHaveAttribute('data-status', 'timeout');
  await expect(logs(page)).not.toContainText('forged console output');
  await expect(logs(page)).not.toContainText('forged execution error');
  await expect(page.locator('iframe[title="Isolated JavaScript execution"]')).toHaveCount(0);
  await expect(page.locator('#run-button')).toBeEnabled();
});

test('legacy caller introspection cannot access the private execution channel', async ({ page }) => {
  await openPlayground(page);
  await compile(page, `
    const findChannel = Function(\`
      let current = arguments.callee;
      for (let depth = 0; current && depth < 30; depth++, current = current.caller) {
        const args = current.arguments;
        const port = args && args[0] && args[0].ports && args[0].ports[0];
        if (port) {
          port.postMessage({ type: 'log', level: 'log', text: 'stolen private channel' });
          port.postMessage({ type: 'completed' });
          return;
        }
      }
    \`);
    findChannel();
    console.log('caller introspection stopped at the boundary');
    while (true) {}
  `);
  await page.locator('#run-button').click();
  await expect(page.locator('#run-status')).toHaveAttribute('data-status', 'timeout');
  await expect(logs(page)).toContainText('caller introspection stopped at the boundary');
  await expect(logs(page)).not.toContainText('stolen private channel');
});

test('a user can stop a program and run another one', async ({ page }) => {
  await openPlayground(page);
  await compile(page, 'while (true) {}');
  await page.locator('#run-button').click();
  await expect(page.locator('#stop-button')).toBeEnabled();
  await page.locator('#stop-button').click();
  await expect(page.locator('#run-status')).toHaveAttribute('data-status', 'stopped');
  await expect(page.locator('iframe[title="Isolated JavaScript execution"]')).toHaveCount(0);
  await compile(page, "console.log('recovered after stop');");
  await run(page);
  await expect(logs(page)).toContainText('recovered after stop');
});

test('asynchronous timers and thrown errors are surfaced', async ({ page }) => {
  await openPlayground(page);
  await compile(page, "setTimeout(() => console.log('timer completed'), 100);");
  await run(page);
  await expect(logs(page)).toContainText('timer completed');

  await compile(page, "throw new Error('intentional runtime failure');");
  await page.locator('#run-button').click();
  await expect(page.locator('#run-status')).toHaveAttribute('data-status', 'error');
  await expect(logs(page)).toContainText('intentional runtime failure');
});

test('excessive output is bounded and the editor remains usable', async ({ page }) => {
  await openPlayground(page);
  await compile(page, "for (let i = 0; i < 1000; i++) console.log('entry', i);");
  await run(page);
  await expect(logs(page)).toContainText('entry 199');
  await expect(logs(page)).not.toContainText('entry 200');
  await expect(logs(page)).toContainText(/truncat|limit|截断|上限/i);
  expect((await logs(page).innerText()).length).toBeLessThan(20_000);
  await compile(page, "console.log('usable after output limit');");
  await run(page);
  await expect(logs(page)).toContainText('usable after output limit');
});

test('oversize UTF-8 input is rejected before compilation and can be replaced', async ({ page }) => {
  await openPlayground(page);
  // This is only 23,000 characters, but exceeds the 64 KiB UTF-8 byte limit.
  await editSource(page, `// ${'界'.repeat(23_000)}`);
  await page.locator('#compile-button').click();
  await expect(page.locator('#error-panel')).toBeVisible();
  await expect(page.locator('#error-message')).toContainText('64 KiB');
  await expect(page.locator('#run-button')).toBeDisabled();
  await compile(page, "console.log('usable after input limit');");
  await run(page);
  await expect(logs(page)).toContainText('usable after input limit');
});

test('execution has no DOM and its opaque iframe cannot read parent storage', async ({ page }) => {
  await openPlayground(page);
  await page.evaluate(() => localStorage.setItem('playground-isolation-test', 'parent-only-value'));
  await compile(page, "console.log('globals', typeof document, typeof window, typeof parent, typeof localStorage); setInterval(() => {}, 100);");
  await page.locator('#run-button').click();
  await expect(logs(page)).toContainText('globals undefined undefined undefined undefined');
  const iframe = page.locator('iframe[title="Isolated JavaScript execution"]');
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  const frame = page.frames().find(frame => frame.url().endsWith('/runner.html'));
  expect(frame).toBeDefined();
  const result = await frame!.evaluate(() => {
    try {
      return window.parent.localStorage.getItem('playground-isolation-test');
    } catch (error) {
      return (error as Error).name;
    }
  });
  expect(result).toBe('SecurityError');
  await page.locator('#stop-button').click();
  await expect(page.locator('#run-status')).toHaveAttribute('data-status', 'stopped');
});

test('runner CSP blocks outgoing fetches', async ({ page, context }) => {
  let outgoingRequests = 0;
  await context.route('https://example.com/**', async route => {
    outgoingRequests++;
    await route.fulfill({ status: 200, body: 'unexpected network access' });
  });
  await openPlayground(page);
  await compile(page, "fetch('https://example.com/blocked-by-playground').then(() => console.log('unexpected fetch success')).catch(error => console.log('fetch blocked', error.name));");
  await run(page);
  await expect(logs(page)).toContainText('fetch blocked TypeError');
  await expect(logs(page)).not.toContainText('unexpected fetch success');
  expect(outgoingRequests).toBe(0);
});

test('the narrow layout supports editing, compilation, execution, and reset', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPlayground(page);
  await compile(page, "console.log('mobile result', 42);");
  await run(page);
  await expect(logs(page)).toContainText('mobile result 42');
  const widths = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    page: document.documentElement.scrollWidth,
  }));
  expect(widths.page).toBeLessThanOrEqual(widths.viewport);
  await page.locator('#reset-button').click();
  await expect(sourceEditor(page)).toContainText('createCounter');
  await expect(page.locator('#run-button')).toBeEnabled();
  await expect(page.locator('#run-status-text')).toHaveText('尚未运行');
  await page.screenshot({ path: testInfo.outputPath('playground-mobile.png'), fullPage: true });
});
