import { describe, expect, it } from 'vitest';
import { parseBlocks, splitCitations } from './markdown';

describe('parseBlocks', () => {
  it('splits paragraphs and preserves citation tokens intact', () => {
    const blocks = parseBlocks('The door opened.\nSee evidence:demo-statement#L5-L7 for the claim.');
    expect(blocks).toEqual([{ kind: 'paragraph', text: 'The door opened.\nSee evidence:demo-statement#L5-L7 for the claim.' }]);
    expect(splitCitations('See evidence:demo-statement#L5-L7 now')).toEqual(['See ', 'evidence:demo-statement#L5-L7', ' now']);
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

  it('parses fenced code and tables', () => {
    const blocks = parseBlocks('```\nhash 1234\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(blocks).toEqual([
      { kind: 'code', language: '', lines: ['hash 1234'] },
      { kind: 'table', header: ['A', 'B'], rows: [['1', '2']] },
    ]);
  });
});
