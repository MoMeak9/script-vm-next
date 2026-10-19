import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

const canonicalUrl = 'https://momeak9.github.io/script-vm-next/';
const repositoryUrl = 'https://github.com/MoMeak9/script-vm-next';
const qrPath = '/script-vm-next/images/wechat-qrcode.jpg';

test('the built HTML exposes consistent search, social, and structured metadata', async ({ page, request }) => {
  const response = await request.get('./');
  expect(response.ok()).toBe(true);
  expect(response.headers()['content-type']).toContain('text/html');
  const html = await response.text();
  const metadata = await page.evaluate(source => {
    const document = new DOMParser().parseFromString(source, 'text/html');
    const meta = (selector: string) => document.querySelector(selector)?.getAttribute('content');
    return {
      language: document.documentElement.lang,
      title: document.title,
      description: meta('meta[name="description"]'),
      canonical: document.querySelector('link[rel="canonical"]')?.getAttribute('href'),
      robots: meta('meta[name="robots"]'),
      og: {
        title: meta('meta[property="og:title"]'),
        description: meta('meta[property="og:description"]'),
        url: meta('meta[property="og:url"]'),
        image: meta('meta[property="og:image"]'),
      },
      twitter: {
        card: meta('meta[name="twitter:card"]'),
        title: meta('meta[name="twitter:title"]'),
        description: meta('meta[name="twitter:description"]'),
        image: meta('meta[name="twitter:image"]'),
      },
      structured: Array.from(document.querySelectorAll('script[type="application/ld+json"]'), script => JSON.parse(script.textContent || 'null')),
    };
  }, html);

  expect(metadata.language).toBe('zh-CN');
  expect(metadata.title).toContain('script-vm-next');
  expect(metadata.title).toContain('JavaScript');
  expect(metadata.title).toContain('在线编译器');
  expect(metadata.description?.length).toBeGreaterThan(40);
  expect(metadata.canonical).toBe(canonicalUrl);
  const robots = metadata.robots?.split(/[\s,]+/);
  expect(robots).toEqual(expect.arrayContaining(['index', 'follow']));
  expect(robots).not.toContain('noindex');
  expect(metadata.og).toMatchObject({
    title: metadata.title,
    description: metadata.description,
    url: canonicalUrl,
  });
  expect(metadata.twitter).toMatchObject({
    card: 'summary_large_image',
    title: metadata.title,
    description: metadata.description,
    image: metadata.og.image,
  });

  const socialImage = new URL(metadata.og.image!);
  expect(socialImage.href.startsWith(canonicalUrl)).toBe(true);
  const imageResponse = await request.get(socialImage.pathname);
  expect(imageResponse.ok()).toBe(true);
  expect(imageResponse.headers()['content-type']).toContain('image/png');
  const image = await imageResponse.body();
  expect(image.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(image.readUInt32BE(16)).toBe(1200);
  expect(image.readUInt32BE(20)).toBe(630);

  expect(metadata.structured.length).toBeGreaterThan(0);
  const graph = metadata.structured.flatMap(value => value['@graph'] ?? [value]);
  for (const type of ['WebSite', 'WebPage', 'SoftwareApplication', 'FAQPage']) {
    const node = graph.find(value => [value['@type']].flat().includes(type));
    expect(node, `JSON-LD includes ${type}`).toBeDefined();
    if (type !== 'FAQPage') expect(node.url).toBe(canonicalUrl);
  }
  const application = graph.find(value => value['@type'] === 'SoftwareApplication');
  expect(application.name).toContain('script-vm-next');
  expect(JSON.stringify(graph)).toContain(repositoryUrl);
});

test('project information, FAQs, and the follow invitation are readable without JavaScript', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    await page.goto('./');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('script-vm-next');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('JavaScript');
    await expect(page.locator('#project-overview')).toBeVisible();
    await expect(page.locator('#project-overview')).toContainText('字节码');
    await expect(page.locator('#project-overview a[href*="docs/compatibility.md"]')).toBeVisible();

    const questions = page.locator('#faq details');
    expect(await questions.count()).toBeGreaterThanOrEqual(3);
    const visibleFaq: { question: string; answer: string }[] = [];
    for (const detail of await questions.all()) {
      const summary = detail.locator('summary');
      await summary.click();
      await expect(detail).toHaveAttribute('open', '');
      const answer = detail.locator('p');
      await expect(answer.first()).toBeVisible();
      visibleFaq.push({
        question: (await summary.innerText()).trim(),
        answer: (await answer.allTextContents()).join(' ').replace(/\s+/g, ' ').trim(),
      });
    }
    const structuredFaq = await page.locator('script[type="application/ld+json"]').evaluateAll(scripts => {
      const graph = scripts.flatMap(script => {
        const value = JSON.parse(script.textContent || 'null');
        return value['@graph'] ?? [value];
      });
      const faq = graph.find(value => [value['@type']].flat().includes('FAQPage'));
      return faq.mainEntity.map((entry: { name: string; acceptedAnswer: { text: string } }) => ({
        question: entry.name.trim(),
        answer: entry.acceptedAnswer.text.replace(/\s+/g, ' ').trim(),
      }));
    });
    expect(structuredFaq).toEqual(visibleFaq);

    await page.locator('header a[href="#wechat"]').click();
    await expect(page).toHaveURL(/#wechat$/);
    await expect(page.locator('#wechat')).toBeVisible();
    await expect(page.locator('#wechat img')).toBeVisible();
    await expect(page.locator('#wechat')).toContainText('公众号');
  } finally {
    await context.close();
  }
});

test('discovery files describe only public content and exclude the execution runner', async ({ page, request }) => {
  const sitemap = await request.get('sitemap.xml');
  expect(sitemap.ok()).toBe(true);
  const locations = await page.evaluate(source => {
    const document = new DOMParser().parseFromString(source, 'application/xml');
    if (document.querySelector('parsererror')) throw new Error('Invalid sitemap XML');
    return Array.from(document.querySelectorAll('loc'), node => node.textContent);
  }, await sitemap.text());
  expect(locations).toEqual([canonicalUrl]);

  const llms = await request.get('llms.txt');
  expect(llms.ok()).toBe(true);
  expect(llms.headers()['content-type']).toContain('text/plain');
  const discovery = await llms.text();
  expect(discovery).toMatch(/^# script-vm-next/m);
  for (const reference of [canonicalUrl, repositoryUrl, 'docs/compatibility.md', 'docs/runtime-assembly.md']) {
    expect(discovery).toContain(reference);
  }
  expect(discovery).toContain("runtime: 'auto'");
  expect(discovery).toMatch(/standalone script/i);
  expect(discovery).toMatch(/dynamic import/);
  expect(discovery).not.toContain('/runner.html');

  const runner = await request.get('runner.html');
  expect(runner.ok()).toBe(true);
  const runnerRobots = await page.evaluate(source => new DOMParser()
    .parseFromString(source, 'text/html')
    .querySelector('meta[name="robots"]')?.getAttribute('content'), await runner.text());
  expect(runnerRobots).toMatch(/\bnoindex\b/);
});

for (const viewport of [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`the ${viewport.name} follow section preserves the QR download and compiler access`, async ({ page, request }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto('./');
    await expect(page.locator('#compile-button')).toBeEnabled();
    await page.locator('header a[href="#wechat"]').click();
    await expect(page).toHaveURL(/#wechat$/);
    const section = page.locator('#wechat');
    await expect(section).toBeVisible();
    const qr = section.locator('img');
    await expect(qr).toHaveAttribute('src', qrPath);
    await expect(qr).toHaveAttribute('alt', /公众号/);
    await qr.scrollIntoViewIfNeeded();
    await expect(qr).toBeVisible();
    await expect.poll(() => qr.evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight])).toEqual([430, 430]);

    const original = await request.get(qrPath);
    expect(original.ok()).toBe(true);
    expect(original.headers()['content-type']).toContain('image/jpeg');
    const originalBytes = await original.body();
    expect(originalBytes).toEqual(await readFile('demo/public/images/wechat-qrcode.jpg'));
    const saveLink = section.locator('a[download="script-vm-next-wechat.jpg"]');
    await expect(saveLink).toHaveAttribute('href', qrPath);
    const downloadPromise = page.waitForEvent('download');
    await saveLink.click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('script-vm-next-wechat.jpg');
    const downloadedPath = await download.path();
    expect(downloadedPath).not.toBeNull();
    expect(await readFile(downloadedPath!)).toEqual(originalBytes);

    const widths = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(widths.document).toBeLessThanOrEqual(widths.viewport);
    await page.locator('#source-editor .cm-content').fill('console.log("usable after following", 42);');
    await page.locator('#compile-button').click();
    await expect(page.locator('#run-button')).toBeEnabled();
    await expect(page.locator('#error-panel')).toBeHidden();
    await page.locator('#run-button').click();
    await expect(page.locator('#run-status')).toHaveAttribute('data-status', 'completed');
    await expect(page.locator('#console-output')).toContainText('usable after following 42');
  });
}
