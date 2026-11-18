import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { build } from 'esbuild';

// Rich answer capture: the site's own Markdown must survive a DOM round trip.
await mkdir('work', { recursive: true });
await build({
  entryPoints: ['src/answers.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'Answers',
  outfile: 'work/answers.js',
  target: 'chrome120',
});
const browser = await chromium.launch({ headless: true });
let checks = 0;
async function check(name, fn) {
  await fn();
  checks++;
  console.log(`PASS rich answer: ${name}`);
}
/**
 * One answer body shaped like provider output: KaTeX-rendered math, a table,
 * code with a language class, a nested task list, a quote and a link.
 */
const html = `
  <div class="ds-markdown" id="answer">
    <h2>Разбор <em>задачи</em></h2>
    <p>Формула: <span class="katex"><span class="katex-mathml"><math><annotation encoding="application/x-tex">E = mc^2</annotation></math></span><span class="katex-html">E=mc²</span></span> и дальше текст.</p>
    <div class="katex-display"><span class="katex"><math><annotation encoding="application/x-tex">\\int_0^1 x^2 dx = \\frac{1}{3}</annotation></math></span></div>
    <table>
      <thead><tr><th align="left">Поле</th><th align="right">Значение</th></tr></thead>
      <tbody><tr><td>a</td><td>1</td></tr><tr><td>b</td><td>2</td></tr></tbody>
    </table>
    <pre class="language-python"><code class="language-python"><span class="token keyword">print</span>(<span>"42"</span>)</code></pre>
    <ul>
      <li>Первый пункт<ul><li>Вложенный</li></ul></li>
      <li>Второй <a href="https://example.test/doc">ссылка</a></li>
    </ul>
    <blockquote>Цитата</blockquote>
    <ol start="3"><li>Третий</li><li>Четвёртый</li></ol>
    <p><img src="https://chat.deepseek.com/img/chart.png" alt="chart"></p>
    <hr>
    <p>Итог: <strong>готово</strong>.</p>
    <button aria-label="Copy">Copy</button>
  </div>`;
try {
  const page = await browser.newPage();
  await page.setContent(`<article>${html}</article>`);
  await page.addScriptTag({ path: 'work/answers.js' });
  const plain = 'Разбор задачи\nФормула: E = mc² и дальше текст.';
  const answer = () =>
    page.evaluate((plain) => Answers.richAnswer(document.querySelector('#answer'), plain), plain);
  await check('Markdown keeps headings, emphasis, math, tables and fenced code', async () => {
    const { markdown } = await answer();
    assert.match(markdown, /^## Разбор \*задачи\*$/m);
    assert.match(markdown, /Формула: \$E = mc\^2\$ и дальше текст\./);
    assert.match(markdown, /\$\$\n\\int_0\^1 x\^2 dx = \\frac\{1\}\{3\}\n\$\$/);
    assert.match(
      markdown,
      /\| Поле \| Значение \|\n\| :--- \| ---: \|\n\| a \| 1 \|\n\| b \| 2 \|/,
    );
    assert.match(markdown, /```python\nprint\("42"\)\n```/);
    assert.match(
      markdown,
      /- Первый пункт\n  - Вложенный\n- Второй \[ссылка\]\(https:\/\/example\.test\/doc\)/,
    );
    assert.match(markdown, /> Цитата/);
    assert.match(markdown, /3\. Третий\n4\. Четвёртый/);
    assert.match(markdown, /!\[chart\]\(https:\/\/chat\.deepseek\.com\/img\/chart\.png\)/);
    assert.match(markdown, /Итог: \*\*готово\*\*\./);
    assert.doesNotMatch(markdown, /<|Copy|E=mc²/);
    assert.equal(markdown.includes('```\n```'), false);
  });
  await check('content tree mirrors the Markdown blocks', async () => {
    const { content } = await answer();
    const types = content.blocks.map((block) => block.type);
    assert.deepEqual(types, [
      'heading',
      'paragraph',
      'math',
      'table',
      'code',
      'list',
      'quote',
      'list',
      'image',
      'rule',
      'paragraph',
    ]);
    const table = content.blocks[3];
    assert.deepEqual(table.header, ['Поле', 'Значение']);
    assert.deepEqual(table.rows, [
      ['a', '1'],
      ['b', '2'],
    ]);
    assert.deepEqual(table.align, ['left', 'right']);
    const code = content.blocks[4];
    assert.equal(code.language, 'python');
    assert.equal(code.text, 'print("42")');
    const lists = content.blocks.filter((block) => block.type === 'list');
    assert.deepEqual(lists[0].items, [
      'Первый пункт\n  - Вложенный',
      'Второй [ссылка](https://example.test/doc)',
    ]);
    assert.equal(lists[1].ordered, true);
    assert.equal(lists[1].start, 3);
    assert.equal(content.blocks[2].display, true);
    assert.equal(content.blocks[2].latex, '\\int_0^1 x^2 dx = \\frac{1}{3}');
    assert.equal(content.plain, plain);
    assert.equal(content.version, 1);
  });
  await check('every content block renders back to its Markdown source', async () => {
    const result = await page.evaluate((plain) => {
      const answer = Answers.richAnswer(document.querySelector('#answer'), plain);
      return {
        expected: answer.markdown,
        actual: answer.content.blocks.map(Answers.blockMarkdown).join('\n\n'),
      };
    }, plain);
    assert.equal(result.actual.replace(/\n{3,}/g, '\n\n').trim(), result.expected);
  });
  await check('plain text and provider copy control are detected, not clicked', async () => {
    const data = await page.evaluate(
      (plain) => ({
        content: Answers.answerContent(document.querySelector('#answer'), plain),
        copy: Answers.hasProviderCopy(document.querySelector('#answer')),
        none: Answers.hasProviderCopy(document.createElement('div')),
        rich: Answers.richAnswer(document.querySelector('#answer'), ''),
      }),
      plain,
    );
    assert.equal(data.content.plain, plain);
    assert.equal(data.copy, true);
    assert.equal(data.none, false);
    assert.ok(data.rich.markdown.startsWith('##'));
  });
  await check('localized copy labels are recognized across providers', async () => {
    const found = await page.evaluate(() => [
      Answers.hasProviderCopy(
        (() => {
          const node = document.createElement('div');
          node.innerHTML = '<button aria-label="Копировать"></button>';
          return node;
        })(),
      ),
      Answers.hasProviderCopy(
        (() => {
          const node = document.createElement('div');
          node.innerHTML = '<div role="button" title="复制"></div>';
          return node;
        })(),
      ),
      Answers.hasProviderCopy(document.createElement('div')),
    ]);
    assert.deepEqual(found, [true, true, false]);
  });
  await check('answers without rich markup fall back to the plain capture', async () => {
    const fallback = await page.evaluate(() => {
      const node = document.createElement('p');
      node.textContent = 'Просто текст';
      return Answers.richAnswer(node, 'Просто текст');
    });
    assert.equal(fallback.markdown, 'Просто текст');
    assert.deepEqual(fallback.content.blocks, [{ type: 'paragraph', markdown: 'Просто текст' }]);
  });
  await check('conversion is idempotent and leaves the page untouched', async () => {
    const before = await page.evaluate(() => document.body.innerHTML);
    const first = await answer();
    const second = await answer();
    assert.deepEqual(second, first);
    assert.equal(await page.evaluate(() => document.body.innerHTML), before);
  });
  // DeepSeek/Qwen render long equations as TeX inside code-like wrappers.
  await check('TeX in wrapper elements is never mistaken for code', async () => {
    await page.setContent(
      '<div id="answer"><span class="katex"><math><annotation encoding="application/x-tex">x^2</annotation></math></span></div>',
    );
    const markdown = await page.evaluate(() =>
      Answers.richAnswer(document.querySelector('#answer'), 'x^2'),
    );
    assert.equal(markdown.markdown.trim(), '$x^2$');
  });
  await page.close();
  console.log(`Rich answer fixtures: ${checks} checks passed; local pages only.`);
} finally {
  await browser.close();
}
