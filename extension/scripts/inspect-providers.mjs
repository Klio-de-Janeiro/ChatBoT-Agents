// Read-only inspection of public, unauthenticated pages in a fresh test profile.
// Does not attach to, copy or alter the user's Chrome profile or cookies.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('work/provider-inspection', { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const report = [];
  for (const [provider, url] of Object.entries({
    deepseek: 'https://chat.deepseek.com/',
    qwen: 'https://chat.qwen.ai/',
  })) {
    const page = await browser.newPage();
    let status, error;
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      status = response?.status();
      await page.waitForTimeout(2000);
    } catch (e) {
      error = e.message;
    }
    const inspection = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      text: document.body?.innerText.slice(0, 2500),
      elements: [...document.querySelectorAll('textarea,input,button,[contenteditable],iframe')]
        .slice(0, 80)
        .map((e) => ({
          tag: e.tagName,
          id: e.id,
          role: e.getAttribute('role'),
          label: e.getAttribute('aria-label'),
          placeholder: e.getAttribute('placeholder'),
          type: e.getAttribute('type'),
          testid: e.getAttribute('data-testid'),
          text: e.textContent?.slice(0, 80),
        })),
    }));
    report.push({ provider, status, error, ...inspection });
    await page.screenshot({ path: `work/provider-inspection/${provider}.png` });
    await page.close();
  }
  await writeFile(
    'work/provider-inspection/report.json',
    JSON.stringify({ date: new Date().toISOString(), report }, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}
