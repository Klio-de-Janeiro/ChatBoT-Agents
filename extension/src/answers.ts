/**
 * Capture answers exactly as the provider renders them.
 *
 * The plain `text` field of a result stays the compatibility contract
 * (README/CONTRACT, `responses/<job>.txt`). This module adds two lossless
 * siblings:
 *
 * - `markdown`: the answer in the provider's own Markdown dialect, i.e. what
 *   the website itself would place on the clipboard ("Copy answer"). It keeps
 *   headings, tables, lists, task lists, quotes, fenced code with the
 *   provider's original fence info string and `$...$` / `\\[...\\]` math.
 * - `content`: the same answer as a structured, renderer-neutral tree
 *   (headings, paragraphs, lists, tables, code, formulas, math blocks,
 *   images) for future rich renderers. Image bodies are not embedded; `src`
 *   is kept as-is and a missing image never blocks the answer capture.
 *
 * Everything here is a pure DOM -> data conversion. It never mutates the
 * provider page, never loads external resources and never reads extension
 * storage. Math conversion is implemented locally: MV3 forbids remote
 * scripts and this extension ships no KaTeX/MathJax bundle.
 */
import { normalize } from './dom';

export type AnswerBlock =
  | {
      type: 'heading';
      level: 1 | 2 | 3 | 4 | 5 | 6;
      /** Plain text, e.g. for an outline. */
      text: string;
      /** Inline Markdown; keeps emphasis the heading itself had. */
      markdown: string;
    }
  | { type: 'paragraph'; markdown: string }
  | { type: 'list'; ordered: boolean; items: string[]; start?: number }
  | { type: 'quote'; markdown: string }
  | { type: 'table'; header: string[]; rows: string[][]; align: (string | null)[] }
  | { type: 'code'; language: string; text: string; markdown: string }
  | { type: 'math'; latex: string; display: boolean; markdown: string }
  | { type: 'image'; alt: string; src: string; markdown: string }
  | { type: 'rule'; markdown: string };
export type AnswerContent = {
  /** RICH_ANSWER_VERSION at capture time; consumers check before reading blocks. */
  version: number;
  /** The compatibility text, so a renderer can always fall back to it. */
  plain: string;
  blocks: AnswerBlock[];
};
/** Providers expose the rendered answer as HTML; `textContent` loses Markdown. */
export type RichAnswer = { markdown: string; content: AnswerContent };

const SKIP = 'script,style,noscript,template,button,[role="button"],[aria-hidden="true"]';
const CODE = 'pre code,pre,[class*="code-block"],[class*="highlight"],code[class*="language-"]';
const LIST = 'ul,ol';
const MATH = '.katex,.katex-display,math,annotation';
// Elements that end the current inline run. Inside an unknown `<div>` wrapper
// they are handled by the block walk instead of being flattened.
const BLOCKY = 'h1,h2,h3,h4,h5,h6,table,ul,ol,pre,blockquote,hr,[class*="code-block"]';
const BREAK = new Set(['div', 'p', 'li', 'tr', 'section', 'article', 'blockquote']);

const escapeMarkdown = (text: string): string => text.replace(/([\\`*_[\]])/g, '\\$1');
const longestRun = (text: string): number => {
  let best = 0;
  for (const match of text.matchAll(/`+/g)) best = Math.max(best, match[0].length);
  return best;
};

/** Markdown for one inline run of nodes (the inside of a paragraph or cell). */
function inlineMarkdown(root: Element, skip: Set<Element> = new Set()): string {
  return inlineNodes([...root.childNodes], skip);
}
/** Markdown for an arbitrary run of sibling nodes (a paragraph segment). */
function inlineNodes(nodes: Node[], skip: Set<Element> = new Set()): string {
  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return escapeMarkdown(node.nodeValue ?? '');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const element = node as Element;
    if (element.matches(SKIP) || skip.has(element)) return '';
    if (element.matches(CODE)) return codeMarkdown(element);
    if (element.localName === 'br') return '\n';
    if (element.matches('strong,b')) return surround(element, '**');
    if (element.matches('em,i')) return surround(element, '*');
    if (element.matches('del,s,strike')) return surround(element, '~~');
    if (element.matches('a')) return link(element);
    if (element.localName === 'img') return imageMarkdown(element);
    if (element.matches('kbd')) return `\`${element.textContent ?? ''}\``;
    if (element.matches(MATH)) return mathMarkdown(element);
    return children(element);
  };
  const surround = (element: Element, marker: string): string => {
    const text = children(element);
    return text.trim() ? `${marker}${text}${marker}` : text;
  };
  const link = (element: Element): string => {
    const label = children(element);
    const href = element.getAttribute('href') ?? '';
    return /^https?:|^\/(?!\/)/.test(href) && label ? `[${label}](${href})` : label;
  };
  const children = (element: Element): string => {
    let text = '';
    for (const child of [...element.childNodes]) {
      // The parent list converts a nested list itself, with indentation.
      if (child.nodeType === Node.ELEMENT_NODE && skip.has(child as Element)) continue;
      const value = inline(child);
      if (!value) continue;
      // A block boundary inside an inline wrapper, e.g. <strong><p>yes</p></strong>.
      if (BREAK.has((child as Element).localName ?? '') && text && !text.endsWith('\n'))
        text += '\n';
      text += value;
    }
    return text;
  };
  let text = '';
  for (const node of nodes) {
    if (node.nodeType === Node.ELEMENT_NODE && skip.has(node as Element)) continue;
    const value = inline(node);
    if (!value) continue;
    if (BREAK.has((node as Element).localName ?? '') && text && !text.endsWith('\n')) text += '\n';
    text += value;
  }
  return tidy(text).trim();
}

/**
 * KaTeX renders `$...$` into two parallel DOM trees: visual HTML/MathML plus
 * the TeX source in `<annotation encoding="application/x-tex">`. Providers may
 * also leave raw `\\(...\\)`, `\\[...\\]` or `$$...$$` in ordinary text nodes.
 */
function mathMarkdown(element: Element): string {
  const annotation = element.querySelector('annotation[encoding="application/x-tex"]');
  const tex = normalize(annotation?.textContent ?? mathText(element));
  if (!tex || /[<>]/.test(tex)) return '';
  const display =
    element.matches('.katex-display') ||
    element.getAttribute('display') === 'block' ||
    !!annotation?.closest('.katex-display');
  const source = tex.replace(/^\\\[/, '').replace(/\\\]$/, '').trim();
  if (display) return `\n\n$$\n${source}\n$$\n\n`;
  // A TeX delimiter pair the provider itself can render again.
  return source.length <= 400 ? `$${source}$` : `\\(${source}\\)`;
}
/** Rendered math text without the visual duplicate KaTeX adds to MathML. */
function mathText(element: Element): string {
  if (!element.querySelector('.katex-html')) return element.textContent ?? '';
  const copy = element.cloneNode(true) as Element;
  for (const visual of copy.querySelectorAll('.katex-html')) visual.remove();
  return copy.textContent ?? '';
}

/**
 * Providers render code areas with many nested spans; reconstructing a fenced
 * block from textContent preserves the code and drops decoration markup.
 */
function codeMarkdown(element: Element): string {
  const pre = element.localName === 'pre' ? element : (element.closest('pre') ?? element);
  const text = (element.textContent ?? '')
    .replace(/\u200b/g, '')
    .replace(/\r\n/g, '\n')
    .trimEnd();
  if (!text.trim()) return '';
  const language = codeLanguage(element) ?? codeLanguage(pre);
  const fence = '`'.repeat(Math.max(3, longestRun(text) + 1));
  return `\n\n${fence}${language}\n${text}\n${fence}\n\n`;
}
function codeLanguage(element: Element): string | undefined {
  for (const candidate of [element, element.querySelector('[class*="language-"]')])
    for (const name of candidate?.getAttribute('class')?.split(/\s+/) ?? [])
      if (/^language-[A-Za-z0-9+#._-]{1,32}$/.test(name)) return name.slice(9);
  const label = element.getAttribute('data-language') ?? '';
  return /^[A-Za-z0-9+#._-]{1,32}$/.test(label) ? label : undefined;
}

/**
 * Collapse provider padding and stray whitespace while leaving fenced code
 * untouched: code indentation is significant, everything else is not.
 */
export function tidy(markdown: string): string {
  const output: string[] = [];
  let fence: string | undefined;
  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const open = line.match(/^(`{3,}|~{3,})/)?.[1];
    if (fence) {
      output.push(line);
      if (open && open[0] === fence[0] && open.length >= fence.length) fence = undefined;
      continue;
    }
    if (open) {
      fence = open;
      if (output.at(-1)?.trim()) output.push('');
      output.push(line);
      continue;
    }
    // Leading indentation is significant for nested lists and continuations;
    // only repeated inner spaces and trailing padding are provider noise.
    const leading = /^[ \t]*/.exec(line)![0];
    const collapsed = leading + line.slice(leading.length).replace(/[ \t]+/g, ' ');
    if (!collapsed.trim() && !output.at(-1)?.trim()) continue;
    output.push(collapsed);
  }
  while (output.length && !output[0]!.trim()) output.shift();
  while (output.length && !output.at(-1)!.trim()) output.pop();
  return output.join('\n');
}

/** Structured answer tree for renderers; also the source of `markdown`. */
export function htmlToContent(root: Element): AnswerBlock[] {
  return collect(root.childNodes, root);
}
/** Block-level collection for a node list; `root` stays the answer element. */
function collect(nodes: Iterable<Node>, root: Element): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = normalize(node.nodeValue ?? '');
      if (text) blocks.push({ type: 'paragraph', markdown: escapeMarkdown(text) });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as Element;
    if (element.matches(SKIP)) return;
    if (element.matches(CODE)) {
      const markdown = tidy(codeMarkdown(element));
      if (!markdown) return;
      blocks.push({
        type: 'code',
        language: codeLanguage(element) ?? '',
        text: (element.textContent ?? '')
          .replace(/\u200b/g, '')
          .replace(/\r\n/g, '\n')
          .trimEnd(),
        markdown,
      });
      return;
    }
    if (element.matches('table,[role="table"]')) {
      blocks.push(table(element));
      return;
    }
    if (element.matches(LIST)) {
      // A nested list belongs to the item of the enclosing list (see listBlock).
      const owner = element.parentElement?.closest('li');
      if (!owner || !owner.parentElement?.matches(LIST)) blocks.push(listBlock(element));
      return;
    }
    if (/^h[1-6]$/.test(element.localName)) {
      const text = normalize(element.textContent ?? '');
      const level = Number(element.localName[1]) as 1 | 2 | 3 | 4 | 5 | 6;
      if (text) blocks.push({ type: 'heading', level, text, markdown: inlineMarkdown(element) });
      return;
    }
    if (element.localName === 'blockquote') {
      // Quoted content is collected from the quote's children, never from the
      // root itself, otherwise the block walk would recurse into itself.
      const markdown = joinBlocks(collect(element.childNodes, root));
      if (markdown)
        blocks.push({
          type: 'quote',
          markdown: markdown
            .split('\n')
            .map((line) => `> ${line}`)
            .join('\n'),
        });
      return;
    }
    if (element.localName === 'hr') {
      blocks.push({ type: 'rule', markdown: '---' });
      return;
    }
    if (element.localName === 'img') {
      if (element.getAttribute('src')) blocks.push(imageBlock(element));
      return;
    }
    if (element.matches(MATH)) {
      const markdown = mathMarkdown(element).trim();
      if (markdown) {
        const display = markdown.startsWith('$$');
        blocks.push({
          type: 'math',
          latex: markdown.replace(/^\$+|\$+$/g, '').trim(),
          display,
          markdown,
        });
      }
      return;
    }
    if (element.matches('p,div,section,article') && !element.querySelector(BLOCKY)) {
      for (const block of segment(element)) blocks.push(block);
      return;
    }
    // A container of other blocks (or any unknown wrapper) is transparent.
    for (const child of [...element.childNodes]) visit(child);
  };
  for (const node of [...nodes]) visit(node);
  return mergeParagraphs(blocks);
}

/**
 * Split an inline container into text segments and images, so a picture is a
 * block of its own (its `src`/`alt` stay available to rich copy/read actions).
 */
function segment(element: Element): AnswerBlock[] {
  const seen: AnswerBlock[] = [];
  let run: Node[] = [];
  const flush = (): void => {
    // Text segments are converted from their original nodes for exact fidelity.
    const markdown = inlineNodes(run);
    if (markdown) seen.push({ type: 'paragraph', markdown });
    run = [];
  };
  for (const child of [...element.childNodes]) {
    const images =
      child.nodeType === Node.ELEMENT_NODE
        ? (child as Element).localName === 'img'
          ? [child as Element]
          : [...(child as Element).querySelectorAll('img')]
        : [];
    const onlyImages =
      images.length > 0 &&
      (child as Element).textContent?.trim() === '' &&
      !(child as Element).querySelector('a,button,[role="button"]');
    if (!onlyImages) {
      run.push(child);
      continue;
    }
    flush();
    for (const image of images) if (image.getAttribute('src')) seen.push(imageBlock(image));
  }
  flush();
  return seen;
}

function mergeParagraphs(blocks: AnswerBlock[]): AnswerBlock[] {
  const output: AnswerBlock[] = [];
  for (const block of blocks) {
    const previous = output.at(-1);
    if (
      block.type === 'paragraph' &&
      previous?.type === 'paragraph' &&
      !previous.markdown.includes('\n\n') &&
      !block.markdown.includes('\n\n')
    ) {
      previous.markdown += '\n' + block.markdown;
      continue;
    }
    output.push(block);
  }
  return output;
}

function imageMarkdown(element: Element): string {
  const src = element.getAttribute('src') ?? '';
  return src ? `![${escapeMarkdown(element.getAttribute('alt') ?? '')}](${src})` : '';
}
const imageBlock = (element: Element): AnswerBlock => {
  const alt = element.getAttribute('alt') ?? '';
  return {
    type: 'image',
    alt,
    src: element.getAttribute('src') ?? '',
    markdown: imageMarkdown(element),
  };
};

function table(element: Element): AnswerBlock {
  const rows = [...element.querySelectorAll('tr,[role="row"]')];
  const cells = (row: Element): string[] =>
    [...row.querySelectorAll('th,td,[role="cell"],[role="columnheader"],[role="rowheader"]')].map(
      (cell) => inlineMarkdown(cell),
    );
  const headerRow = rows.find((row) => row.closest('thead')) ?? rows[0];
  const header = headerRow ? cells(headerRow) : [];
  const body = rows.filter((row) => row !== headerRow).map(cells);
  return {
    type: 'table',
    header: header.map((cell) => cell.replace(/\n/g, ' ')),
    rows: body,
    align: headerRow
      ? [...headerRow.querySelectorAll('th,td,[role="cell"],[role="columnheader"]')].map((cell) =>
          cell.getAttribute('align'),
        )
      : [],
  };
}

function listBlock(element: Element): AnswerBlock {
  const ordered = element.localName === 'ol';
  const start = ordered ? Number(element.getAttribute('start') ?? 1) : undefined;
  const items = [...element.children]
    .filter((child) => child.localName === 'li')
    .map((child) => {
      // A nested list is indented under its parent item as Markdown. It is
      // converted through a skip set, so the live provider DOM is never mutated.
      const nested = [...child.querySelectorAll(':scope > ul,:scope > ol')];
      const skip = new Set<Element>();
      for (const sub of nested) {
        skip.add(sub);
        for (const inner of sub.querySelectorAll('*')) skip.add(inner);
      }
      const markdown = tidy(inlineMarkdown(child, skip));
      // A nested list keeps its own markers and is indented under the item.
      const tail = nested.map((sub) => indent(blockMarkdown(listBlock(sub)), '  '));
      return tail.length ? [markdown, ...tail].join('\n') : markdown;
    })
    .filter((item) => item.trim());
  return { type: 'list', ordered, items, ...(ordered && start !== 1 ? { start } : {}) };
}
const indent = (text: string, prefix: string): string =>
  text
    .split('\n')
    .map((line) => (line.trim() ? prefix + line : line))
    .join('\n');

/** One block as Markdown; `join` of these reproduces `richAnswer().markdown`. */
export function blockMarkdown(block: AnswerBlock): string {
  switch (block.type) {
    case 'heading':
      return `${'#'.repeat(block.level)} ${block.markdown}`;
    case 'table':
      return tableMarkdown(block);
    case 'list':
      // Items are Markdown-ready: nested content keeps its own indentation.
      return block.items
        .map((item, index) => (block.ordered ? `${(block.start ?? 1) + index}. ` : '- ') + item)
        .join('\n');
    default:
      return block.markdown;
  }
}

function tableMarkdown(block: Extract<AnswerBlock, { type: 'table' }>): string {
  const width = Math.max(block.header.length, ...block.rows.map((row) => row.length), 1);
  const pad = (row: string[]): string =>
    '| ' +
    [...row, ...Array.from({ length: width - row.length }, () => '')]
      .map((cell) => cell.replace(/\|/g, '\\|').replace(/\n/g, ' '))
      .join(' | ') +
    ' |';
  const shape = Math.max(block.header.length, block.rows[0]?.length ?? 0, 1);
  const rule = Array.from({ length: shape }, (_, index) => {
    const align = block.align[index];
    return align === 'center'
      ? ':---:'
      : align === 'right'
        ? '---:'
        : align === 'left'
          ? ':---'
          : '---';
  });
  const header = block.header.length ? block.header : Array(shape).fill('');
  return [pad(header), pad(rule), ...block.rows.map(pad)].join('\n');
}

/** Full Markdown document for a DOM subtree (blocks joined in order). */
export function htmlToMarkdown(root: Element): string {
  return joinBlocks(htmlToContent(root));
}
const joinBlocks = (blocks: AnswerBlock[]): string =>
  tidy(blocks.map((block) => blockMarkdown(block)).join('\n\n'));

/**
 * Providers expose their own copy control whose label is localized. Only
 * attributes are inspected: layouts that hide the toolbar until hover still
 * carry aria-label/title, and `innerText` on candidates could force layout.
 */
export function hasProviderCopy(element: Element): boolean {
  return !!element.querySelector(
    '[aria-label*="copy" i],[title*="copy" i],[aria-label*="Копировать" i],[title*="Копировать" i],[aria-label*="复制"],[title*="复制"]',
  );
}

/**
 * Bumps when the shape of `markdown`/`content` changes. Consumers read
 * `content.version` before relying on block details.
 */
export const RICH_ANSWER_VERSION = 1;

/** Lossless answer capture: the provider's Markdown plus the structured tree. */
export function richAnswer(answer: Element, plain: string): RichAnswer {
  const blocks = htmlToContent(answer);
  const markdown = tidy(blocks.map(blockMarkdown).join('\n\n'));
  const content: AnswerContent = { version: RICH_ANSWER_VERSION, plain, blocks };
  if (!markdown)
    return {
      markdown: plain,
      content: { ...content, blocks: [{ type: 'paragraph', markdown: plain }] },
    };
  return { markdown, content };
}

/** Content-only capture for callers that do not need the Markdown projection. */
export const answerContent = (answer: Element, plain: string): AnswerContent => ({
  version: RICH_ANSWER_VERSION,
  plain,
  blocks: htmlToContent(answer),
});

/** Localized labels recognized as the provider's own "copy answer" action. */
export const PROVIDER_COPY_LABELS = ['copy', 'копировать', '复制'];
