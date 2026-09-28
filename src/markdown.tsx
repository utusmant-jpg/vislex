// Block-level markdown renderer with VisLex citation chips inline. Hand-rolled so the
// whole app stays dependency-free and offline; covers the constructs the investigator
// actually emits: headings, lists, tables, fenced code, quotes, emphasis, citations.
import { citationParts } from './bridge';
import { CitationChip } from './ui';

export type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; language: string; lines: string[] }
  | { kind: 'quote'; lines: string[] }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'rule' };

const citationPattern = /(evidence:[a-zA-Z0-9-]+#(?:R[1-9]\d*L[1-9]\d*-L[1-9]\d*|L\d+-L\d+|image|media|artifact:[a-zA-Z0-9-]+))/g;

export function splitCitations(text: string): string[] {
  return text.split(citationPattern);
}

function tableRow(line: string): string[] {
  return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function isTableDivider(line: string): boolean {
  return /^\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
}

export function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
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
    if (line.startsWith('> ')) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].startsWith('> ')) { quote.push(lines[index].slice(2)); index += 1; }
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
      blocks.push({ kind: 'list', ordered, items });
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
    while (index < lines.length && lines[index].trim() && !/^(#{1,4}\s|> |```|(\s*([-*]|\d+[.)])\s))/.test(lines[index]) && !/^(-{3,}|\*{3,})\s*$/.test(lines[index])) {
      paragraph.push(lines[index]);
      index += 1;
    }
    if (paragraph.length) blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
    else index += 1; // unreachable defensive line: skip stray formatting
  }
  return blocks;
}

const emphasisPattern = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g;

export function InlineMarkdown({ text, onSource }: { text: string; onSource: (id: string, locator?: string) => void }) {
  return <>
    {splitCitations(text).map((part, index) => {
      if (citationParts(part)) return <CitationChip key={index} value={part} onOpen={(sourceId, locator) => onSource(sourceId, locator)} />;
      return <span key={index}>{part.split(emphasisPattern).map((segment, position) => {
        if (segment.startsWith('**') && segment.endsWith('**') && segment.length > 4) return <strong key={position}>{segment.slice(2, -2)}</strong>;
        if (segment.startsWith('*') && segment.endsWith('*') && segment.length > 2 && !segment.startsWith('**')) return <em key={position}>{segment.slice(1, -1)}</em>;
        if (segment.startsWith('`') && segment.endsWith('`') && segment.length > 2) return <code key={position} className="inline-code">{segment.slice(1, -1)}</code>;
        return segment;
      })}</span>;
    })}
  </>;
}

export function Markdown({ text, onSource, caret, className }: { text: string; onSource: (id: string, locator?: string) => void; caret?: boolean; className?: string }) {
  const blocks = parseBlocks(text);
  const last = blocks.length - 1;
  return <div className={`markdown-body ${className ?? ''}`}>
    {blocks.map((block, index) => {
      const tail = caret && index === last ? <span className="stream-caret" aria-hidden="true" /> : null;
      switch (block.kind) {
        case 'heading': {
          const Tag = (block.level <= 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5') as 'h3' | 'h4' | 'h5';
          return <Tag key={index}><InlineMarkdown text={block.text} onSource={onSource} />{tail}</Tag>;
        }
        case 'paragraph':
          return <p key={index}>{block.text.split('\n').map((line, lineIndex) => <span key={lineIndex}>
            <InlineMarkdown text={line} onSource={onSource} />{lineIndex < block.text.split('\n').length - 1 ? <br /> : null}
          </span>)}{tail}</p>;
        case 'code':
          return <pre className="code-block" key={index}><code>{block.lines.join('\n')}</code>{tail}</pre>;
        case 'quote':
          return <blockquote key={index}>{block.lines.map((line, lineIndex) => <p key={lineIndex}><InlineMarkdown text={line} onSource={onSource} /></p>)}{tail}</blockquote>;
        case 'list': {
          const Tag = block.ordered ? 'ol' : 'ul';
          return <Tag key={index}>{block.items.map((item, itemIndex) => <li key={itemIndex}><InlineMarkdown text={item} onSource={onSource} /></li>)}{tail}</Tag>;
        }
        case 'table':
          return <div className="table-wrap" key={index}><table>
            <thead><tr>{block.header.map((cell, cellIndex) => <th key={cellIndex}><InlineMarkdown text={cell} onSource={onSource} /></th>)}</tr></thead>
            <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}><InlineMarkdown text={cell} onSource={onSource} /></td>)}</tr>)}</tbody>
          </table>{tail}</div>;
        case 'rule':
        default:
          return <hr key={index} />;
      }
    })}
    {caret && !blocks.length ? <p><span className="stream-caret" aria-hidden="true" /></p> : null}
  </div>;
}
