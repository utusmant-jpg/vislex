// Block-level markdown renderer with VisLex citation chips inline. Hand-rolled so the
// whole app stays dependency-free and offline; covers the constructs the investigator
// actually emits: headings, lists, tables, fenced code, quotes, emphasis, citations.
import { Fragment, memo, useMemo } from 'react';
import { citationParts } from './bridge';
import { CitationChip, CopyButton } from './ui';
import { citationPattern } from './chat/citation-context';

export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; language: string; lines: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: string[]; start?: number }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'rule' };

export function splitCitations(text: string): string[] {
  return text.split(citationPattern);
}

function tableRow(line: string): string[] {
  return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function isTableDivider(line: string): boolean {
  return /^\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
}

const headingPattern = /^(#{1,6})\s+(.*)$/;
// A quote line is ">" optionally followed by one space; a bare ">" is an empty quote line.
const quotePattern = /^>(?: |$)/;

export function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const heading = headingPattern.exec(line);
    if (heading) { blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] }); index += 1; continue; }
    if (/^(---+|\*\*\*+|___+)\s*$/.test(line)) { blocks.push({ kind: 'rule' }); index += 1; continue; }
    if (line.trim().startsWith('```')) {
      const language = line.trim().slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) { code.push(lines[index]); index += 1; }
      index += 1;
      blocks.push({ kind: 'code', language, lines: code });
      continue;
    }
    if (quotePattern.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && quotePattern.test(lines[index])) { quote.push(lines[index].replace(quotePattern, '')); index += 1; }
      blocks.push({ kind: 'quote', lines: quote });
      continue;
    }
    const listMatch = /^(\s*)([-*]|(\d+)[.)])\s+/.exec(line);
    if (listMatch) {
      const ordered = Boolean(listMatch[3]);
      const indent = listMatch[1].length;
      const items: string[] = [];
      while (index < lines.length) {
        const item = new RegExp(`^(\\s{${indent}})([-*]|\\d+[.)])\\s+(.*)$`).exec(lines[index]);
        if (!item) break;
        items.push(item[3]);
        index += 1;
      }
      const start = ordered ? Number(listMatch[3]) : 1;
      blocks.push(ordered && start !== 1 ? { kind: 'list', ordered, items, start } : { kind: 'list', ordered, items });
      continue;
    }
    if (line.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const header = tableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) { rows.push(tableRow(lines[index])); index += 1; }
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !/^(#{1,6}\s|>(?: |$)|```|(\s*([-*]|\d+[.)])\s))/.test(lines[index]) && !/^(-{3,}|\*{3,})\s*$/.test(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
    else index += 1; // unreachable defensive line: skip stray formatting
  }
  return blocks;
}

const emphasisPattern = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;
// A line may break after a chip (an atomic inline), so punctuation touching a
// chip is kept with it: closing marks after, an opening bracket or quote before.
const closingPunctuation = /^[.,;:!?)\]}’”»…%]+/;
const openingPunctuation = /[(\[{‘“«]+$/;

type SourceOpen = (id: string, locator?: string) => void;

/** Plain text split into word spans; while streaming each new word mounts once and fades in. */
function Words({ text, prefix }: { text: string; prefix: string }) {
  return <>{text.split(/(\s+)/).map((word, index) => /^\s*$/.test(word) ? word : <span key={`${prefix}-${index}`} className="stream-word">{word}</span>)}</>;
}

function InlineText({ text, words }: { text: string; words?: boolean }) {
  return <span>{text.split(emphasisPattern).map((segment, position) => {
    if (segment.startsWith('**') && segment.endsWith('**') && segment.length > 4) return <strong key={position}>{segment.slice(2, -2)}</strong>;
    if (segment.startsWith('*') && segment.endsWith('*') && segment.length > 2 && !segment.startsWith('**')) return <em key={position}>{segment.slice(1, -1)}</em>;
    if (segment.startsWith('`') && segment.endsWith('`') && segment.length > 2) return <code key={position} className="inline-code">{segment.slice(1, -1)}</code>;
    return words ? <Words key={position} text={segment} prefix={String(position)} /> : segment;
  })}</span>;
}

export function InlineMarkdown({ text, onSource, words }: { text: string; onSource: SourceOpen; words?: boolean }) {
  const parts = splitCitations(text);
  const chip = (index: number) => !!parts[index] && !!citationParts(parts[index]);
  return <>
    {parts.map((part, index) => {
      if (chip(index)) {
        const before = chip(index - 1) ? '' : openingPunctuation.exec(parts[index - 1] ?? '')?.[0] ?? '';
        const after = closingPunctuation.exec(parts[index + 1] ?? '')?.[0] ?? '';
        const element = <CitationChip value={part} onOpen={(sourceId, locator) => onSource(sourceId, locator)} />;
        return before || after ? <span key={index} className="citation-glue">{before}{element}{after}</span> : <Fragment key={index}>{element}</Fragment>;
      }
      // Punctuation already rendered inside a neighbouring chip's glue.
      const start = chip(index - 1) ? closingPunctuation.exec(part)?.[0].length ?? 0 : 0;
      const end = chip(index + 1) ? part.length - (openingPunctuation.exec(part)?.[0].length ?? 0) : part.length;
      const rest = part.slice(start, Math.max(start, end));
      return rest ? <InlineText key={index} text={rest} words={words} /> : null;
    })}
  </>;
}

/** Content identity of a block, so unchanged blocks skip re-rendering while a draft streams. */
function signature(block: Block): string {
  switch (block.kind) {
    case 'heading': return `h${block.level}:${block.text}`;
    case 'paragraph': return `p:${block.text}`;
    case 'code': return `c:${block.language}:${block.lines.join('\n')}`;
    case 'quote': return `q:${block.lines.join('\n')}`;
    case 'list': return `l:${block.ordered}:${block.start ?? 1}:${block.items.join('\n')}`;
    case 'table': return `t:${block.header.join('|')}:${block.rows.map(row => row.join('|')).join('\n')}`;
    default: return 'r';
  }
}

type BlockProps = { block: Block; signature: string; onSource: SourceOpen; caret: boolean; words: boolean };

const MarkdownBlock = memo(function MarkdownBlock({ block, onSource, caret, words }: BlockProps) {
  const tail = caret ? <span className="stream-caret" aria-hidden="true" /> : null;
  switch (block.kind) {
    case 'heading': {
      const Tag = (block.level <= 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5') as 'h3' | 'h4' | 'h5';
      return <Tag><InlineMarkdown text={block.text} onSource={onSource} words={words} />{tail}</Tag>;
    }
    case 'paragraph': {
      const lines = block.text.split('\n');
      return <p>{lines.map((line, lineIndex) => <span key={lineIndex}>
        <InlineMarkdown text={line} onSource={onSource} words={words} />{lineIndex < lines.length - 1 ? <br /> : null}
      </span>)}{tail}</p>;
    }
    case 'code': {
      const code = block.lines.join('\n');
      return <div className="code-frame">
        <div className="code-head">
          <span className="code-language">{block.language || 'text'}</span>
          <CopyButton text={code} label="Copy code" small />
        </div>
        <pre className="code-block" data-language={block.language || undefined}><code>{code}</code>{tail}</pre>
      </div>;
    }
    case 'quote':
      return <blockquote>{block.lines.map((line, lineIndex) => <p key={lineIndex}><InlineMarkdown text={line} onSource={onSource} words={words} /></p>)}{tail}</blockquote>;
    case 'list': {
      // The streaming caret sits inside the last item: a list may only contain <li> children.
      const items = block.items.map((item, itemIndex) => <li key={itemIndex}><InlineMarkdown text={item} onSource={onSource} words={words} />{itemIndex === block.items.length - 1 ? tail : null}</li>);
      return block.ordered ? <ol start={block.start}>{items}</ol> : <ul>{items}</ul>;
    }
    case 'table':
      return <div className="table-wrap"><table>
        <thead><tr>{block.header.map((cell, cellIndex) => <th key={cellIndex} scope="col"><InlineMarkdown text={cell} onSource={onSource} /></th>)}</tr></thead>
        <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}><InlineMarkdown text={cell} onSource={onSource} /></td>)}</tr>)}</tbody>
      </table>{tail}</div>;
    case 'rule':
    default:
      return <hr />;
  }
}, (previous, next) => previous.signature === next.signature && previous.caret === next.caret && previous.words === next.words && previous.onSource === next.onSource);

/** Renders markdown with inline citation chips. `caret` shows the streaming
 *  caret at the end; `streaming` also fades in newly arrived words of the
 *  block being written (a live draft only, never saved history). */
export function Markdown({ text, onSource, caret, streaming, className }: { text: string; onSource: SourceOpen; caret?: boolean; streaming?: boolean; className?: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const last = blocks.length - 1;
  return <div className={`markdown-body ${className ?? ''}`}>
    {blocks.map((block, index) => <MarkdownBlock key={index} block={block} signature={signature(block)} onSource={onSource} caret={!!caret && index === last} words={!!streaming && index === last} />)}
    {caret && !blocks.length ? <p><span className="stream-caret" aria-hidden="true" /></p> : null}
  </div>;
}
