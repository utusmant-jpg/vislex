"""PPTX text units in presentation order, with hidden slides and speaker notes.

Slide part names (slide3.xml) keep their number when slides are reordered in
PowerPoint, so the shown order comes from ``ppt/presentation.xml``. Paragraph
locators stay ``ppt/slides/slideN.xml:paragraph:i`` so earlier citations keep
their meaning; each slide also gets a ``:slide`` unit stating its position
and whether it is hidden, and a ``:notes`` unit with the speaker notes.
"""
import posixpath
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

A = '{http://schemas.openxmlformats.org/drawingml/2006/main}'
P = '{http://schemas.openxmlformats.org/presentationml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
REL = '{http://schemas.openxmlformats.org/package/2006/relationships}'
MAX_XML_BYTES = 32 * 1024 * 1024
NOTES_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide'


def _xml(package: zipfile.ZipFile, name: str):
    data = package.read(name)
    if b'<!DOCTYPE' in data[:4096].upper() or b'<!ENTITY' in data.upper():
        raise ValueError(f'{name} declares a DTD, which presentations never do')
    return ET.fromstring(data)


def _rels(package: zipfile.ZipFile, part: str) -> dict:
    folder, file = posixpath.split(part)
    name = posixpath.join(folder, '_rels', file + '.rels')
    if name not in package.namelist():
        return {}
    out = {}
    for rel in _xml(package, name).iter(REL + 'Relationship'):
        if rel.get('TargetMode') == 'External':
            continue
        out[rel.get('Id')] = (rel.get('Type'), posixpath.normpath(posixpath.join(folder, rel.get('Target', ''))))
    return out


def _number(name: str) -> int:
    return int(re.search(r'slide([0-9]+)\.xml$', name).group(1))


def _paragraphs(root) -> list[str]:
    return [''.join(node.itertext()) for node in root.iter(A + 'p')]


def extract(source: Path) -> dict:
    pages: list[dict] = []
    with zipfile.ZipFile(source) as package:
        names = set(package.namelist())
        slides = sorted((n for n in names if re.fullmatch(r'ppt/slides/slide[0-9]+\.xml', n)), key=_number)
        if sum(package.getinfo(n).file_size for n in slides) > MAX_XML_BYTES:
            raise ValueError('Document XML exceeds extraction limit')
        ordered = []
        if 'ppt/presentation.xml' in names:
            relations = _rels(package, 'ppt/presentation.xml')
            for entry in _xml(package, 'ppt/presentation.xml').iter(P + 'sldId'):
                target = relations.get(entry.get(R + 'id'), (None, None))[1]
                if target in slides and target not in ordered:
                    ordered.append(target)
        by_presentation = bool(ordered)
        listed_count = len(ordered)
        # Slides present in the package but not listed are kept, after the listed ones.
        ordered += [name for name in slides if name not in ordered]
        hidden = with_notes = 0
        for position, name in enumerate(ordered, 1):
            root = _xml(package, name)
            is_hidden = root.get('show') == '0'
            hidden += is_hidden
            listed = position <= listed_count
            label = f'Slide {position} of {len(ordered)}' + (' in presentation order' if listed else ' by part number') + (' · hidden in slideshow' if is_hidden else '')
            pages.append({'locator': f'{name}:slide', 'text': label, 'method': 'pptx presentation order'})
            for index, text in enumerate(_paragraphs(root), 1):
                pages.append({'locator': f'{name}:paragraph:{index}', 'text': text, 'method': 'document-xml'})
            for kind, target in _rels(package, name).values():
                if kind != NOTES_TYPE or target not in names:
                    continue
                notes_root = _xml(package, target)
                body = []
                for shape in notes_root.iter(P + 'sp'):
                    placeholder = shape.find(f'{P}nvSpPr/{P}nvPr/{P}ph')
                    if placeholder is not None and placeholder.get('type') == 'body':
                        body += _paragraphs(shape)
                text = '\n'.join(body).strip()
                if text:
                    with_notes += 1
                    pages.append({'locator': f'{name}:notes', 'text': f'Speaker notes: {text}', 'method': 'pptx notes slide'})
    notes = ['Text only; slide layout, images, charts, comments, embedded files and animations are not rendered. Original file is preserved.',
             'Slides are listed in presentation order when the presentation part names it; hidden slides are marked, not skipped.']
    return {'pages': pages, 'notes': notes, 'metadata': {'slides': len(ordered), 'hidden_slides': hidden, 'slides_with_notes': with_notes, 'presentation_order': by_presentation}}
