"""DOCX text units read directly from the WordprocessingML parts.

python-docx's ``Paragraph.text`` only walks direct runs, so text inside a
tracked insertion (``w:ins``) silently disappears. This reader walks the XML
instead and keeps the reading a user sees in Word with changes shown as
accepted: insertions included, deletions excluded. Every paragraph that
carries tracked changes also gets a separate unit listing each insertion and
deletion with its declared author and date, so nothing is hidden. Comments,
headers, footers, footnotes and endnotes become their own units.

Block locators stay ``block:{n}:paragraph`` and ``block:{n}:table:row:{r}``
so citations made against earlier extractions keep their meaning.
"""
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
R_NS = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
MAX_XML_BYTES = 64 * 1024 * 1024
REMOVED = {W + 'del', W + 'moveFrom'}


def _text(node, include_removed=False) -> str:
    """Visible text of a node. Removed runs are skipped unless asked for."""
    out: list[str] = []

    def walk(element, removed):
        tag = element.tag
        removed = removed or tag in REMOVED
        if tag == W + 'delInstrText' or tag == W + 'instrText':
            return
        if tag == W + 't' or (tag == W + 'delText' and include_removed):
            if include_removed or not removed:
                out.append(element.text or '')
        elif tag == W + 'tab' and (include_removed or not removed):
            out.append('\t')
        elif tag in (W + 'br', W + 'cr') and (include_removed or not removed):
            out.append('\n')
        for child in element:
            walk(child, removed)

    walk(node, False)
    return ''.join(out)


def _changes(paragraph) -> list[str]:
    lines = []
    for element in paragraph.iter():
        if element.tag in (W + 'ins', W + 'del', W + 'moveTo', W + 'moveFrom'):
            kind = {W + 'ins': 'Inserted', W + 'del': 'Deleted', W + 'moveTo': 'Moved here', W + 'moveFrom': 'Moved away'}[element.tag]
            text = _text(element, include_removed=True)
            if not text:
                continue
            author = element.get(W + 'author') or 'unknown author'
            date = element.get(W + 'date') or 'no date'
            lines.append(f'{kind} by {author} ({date}): {text}')
    return lines


def _read(package: zipfile.ZipFile, name: str):
    info = package.getinfo(name)
    if info.file_size > MAX_XML_BYTES:
        raise ValueError(f'{name} exceeds the document XML extraction limit')
    data = package.read(name)
    # Office Open XML never declares a DTD; refusing one rules out entity tricks.
    if b'<!DOCTYPE' in data[:4096].upper() or b'<!ENTITY' in data.upper():
        raise ValueError(f'{name} declares a DTD, which Word documents never do')
    return ET.fromstring(data)


def _part_number(name: str) -> int:
    match = re.search(r'(\d+)\.xml$', name)
    return int(match.group(1)) if match else 0


def extract(source: Path) -> dict:
    pages: list[dict] = []
    tracked = comments = 0
    with zipfile.ZipFile(source) as package:
        names = set(package.namelist())
        if 'word/document.xml' not in names:
            raise ValueError('Not a Word document: word/document.xml is missing')
        body = _read(package, 'word/document.xml').find(W + 'body')
        if body is None:
            raise ValueError('Word document has no body')
        for n, element in enumerate(body, 1):
            if element.tag == W + 'p':
                pages.append({'locator': f'block:{n}:paragraph', 'text': _text(element), 'method': 'docx xml (changes shown as accepted)'})
                changes = _changes(element)
                if changes:
                    tracked += len(changes)
                    pages.append({'locator': f'block:{n}:tracked-changes', 'text': '\n'.join(changes), 'method': 'docx tracked changes'})
            elif element.tag == W + 'tbl':
                for row, cells in enumerate(element.findall(W + 'tr'), 1):
                    text = '\t'.join('\n'.join(_text(p) for p in cell.iter(W + 'p')) for cell in cells.findall(W + 'tc'))
                    pages.append({'locator': f'block:{n}:table:row:{row}', 'text': text, 'method': 'docx xml table'})
                    changes = [line for p in element.iter(W + 'p') for line in _changes(p)] if row == 1 else []
                    if changes:
                        tracked += len(changes)
                        pages.append({'locator': f'block:{n}:table:tracked-changes', 'text': '\n'.join(changes), 'method': 'docx tracked changes'})
            elif element.tag == W + 'sdt':
                text = '\n'.join(_text(p) for p in element.iter(W + 'p'))
                if text:
                    pages.append({'locator': f'block:{n}:content-control', 'text': text, 'method': 'docx xml content control'})

        if 'word/comments.xml' in names:
            for comment in _read(package, 'word/comments.xml').findall(W + 'comment'):
                comments += 1
                author = comment.get(W + 'author') or 'unknown author'
                date = comment.get(W + 'date') or 'no date'
                text = '\n'.join(_text(p) for p in comment.iter(W + 'p'))
                pages.append({'locator': f'comment:{comment.get(W + "id", comments)}', 'text': f'Comment by {author} ({date}):\n{text}', 'method': 'docx comments'})

        for prefix, label in (('header', 'Header'), ('footer', 'Footer')):
            for name in sorted((n for n in names if re.fullmatch(rf'word/{prefix}\d*\.xml', n)), key=_part_number):
                text = '\n'.join(_text(p) for p in _read(package, name).iter(W + 'p')).strip()
                if text:
                    pages.append({'locator': f'{prefix}:{_part_number(name)}', 'text': f'{label}: {text}', 'method': f'docx {prefix}'})

        for part, tag, label in (('word/footnotes.xml', 'footnote', 'Footnote'), ('word/endnotes.xml', 'endnote', 'Endnote')):
            if part not in names:
                continue
            for note in _read(package, part).findall(W + tag):
                # Separator notes (ids -1 and 0, or typed) are layout, not content.
                if note.get(W + 'type'):
                    continue
                text = '\n'.join(_text(p) for p in note.iter(W + 'p')).strip()
                if text:
                    pages.append({'locator': f'{tag}:{note.get(W + "id")}', 'text': f'{label} {note.get(W + "id")}: {text}', 'method': f'docx {tag}s'})

        embedded = sorted(n for n in names if n.startswith('word/embeddings/'))

    notes = ['Paragraph text shows tracked changes as accepted; each insertion and deletion is listed separately with its declared author and date, which are not authenticated.',
             'Comments, headers, footers, footnotes and endnotes are separate units. No page layout, numbering or formatting is implied.']
    notes.append(f'{len(embedded)} embedded object(s) are preserved inside the original but not extracted.' if embedded else 'No embedded objects were found.')
    metadata = {'tracked_changes': tracked, 'comments': comments, 'embedded_objects': len(embedded)}
    return {'pages': pages, 'notes': notes, 'metadata': metadata}
