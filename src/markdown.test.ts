import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, parseBlocks, splitCitations } from './markdown';

describe('parseBlocks', () => {
  it('splits paragraphs and preserves citation tokens intact', () => {
    const blocks = parseBlocks('The door opened.\nSee evidence:demo-statement#L5-L7 for the claim.');
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'The door opened.\nSee evidence:demo-statement#L5-L7 for the claim.' }]);
    expect(splitCitations('See evidence:demo-statement#L5-L7 now')).toEqual(['See ', 'evidence:demo-statement#L5-L7', ' now']);
  });

  // R02 — revision-pinned citation chips render exactly like legacy ones and
  // never split mid-token. Mirrors the Rust grammar fixtures.
  it('keeps revision-pinned citation tokens intact', () => {
    const blocks = parseBlocks('Finding.\nSee evidence:demo-statement#R2L5-L7 for the claim.');
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'Finding.\nSee evidence:demo-statement#R2L5-L7 for the claim.' }]);
    expect(splitCitations('See evidence:demo-statement#R2L5-L7 now')).toEqual(['See ', 'evidence:demo-statement#R2L5-L7', ' now']);
    expect(splitCitations('Mixed evidence:demo-statement#L1-L1 and evidence:demo-statement#R12L3-L4 end'))
      .toEqual(['Mixed ', 'evidence:demo-statement#L1-L1', ' and ', 'evidence:demo-statement#R12L3-L4', ' end']);
  });

  it('parses headings, lists and rules', () => {
    const blocks = parseBlocks('# Findings\n\n- one\n- two\n\n---\n\n1. first\n2. second');
    expect(blocks).toEqual([
      { kind: 'heading', level: 1, text: 'Findings' },
      { kind: 'list', ordered: false, items: ['one', 'two'] },
      { kind: 'rule' },
      { kind: 'list', ordered: true, items: ['first', 'second'] },
    ]);
  });

  it('keeps an ordered list start number and deeper headings', () => {
    expect(parseBlocks('3. third\n4. fourth')).toEqual([{ kind: 'list', ordered: true, items: ['third', 'fourth'], start: 3 }]);
    expect(parseBlocks('##### Detail')).toEqual([{ kind: 'heading', level: 5, text: 'Detail' }]);
  });

  it('keeps a quote together across a bare ">" line', () => {
    expect(parseBlocks('> first\n>\n> second\nAfter')).toEqual([
      { kind: 'quote', lines: ['first', '', 'second'] },
      { kind: 'paragraph', text: 'After' },
    ]);
  });

  it('parses fenced code and tables', () => {
    const blocks = parseBlocks('```\nhash 1234\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(blocks).toEqual([
      { kind: 'code', language: '', lines: ['hash 1234'] },
      { kind: 'table', header: ['A', 'B'], rows: [['1', '2']] },
    ]);
  });
});

describe('Markdown', () => {
  const noop = () => undefined;
  it('places the streaming caret inside the last list item and keeps the list start', () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: '2. second\n3. third', onSource: noop, caret: true }));
    expect(html).toContain('<ol start="2">');
    expect(html).toMatch(/<li><span>third<\/span><span class="stream-caret" aria-hidden="true"><\/span><\/li><\/ol>/);
  });

  it('labels fenced code with its language without changing the code text', () => {
    const html = renderToStaticMarkup(createElement(Markdown, { text: '```json\n{"a":1}\n```', onSource: noop }));
    expect(html).toContain('data-language="json"');
    expect(html).toContain('<code>{&quot;a&quot;:1}</code>');
  });
});
