"""Hidden sheets, rows and columns of an XLSX workbook, read from its XML.

openpyxl's read-only mode does not expose row and column visibility, and a
hidden row can matter as much as a visible one in review. This reads the
worksheet parts with a streaming parser (only row/col start tags) and
returns, per sheet, its state and compacted hidden row and column ranges.
"""
import posixpath
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

S = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
R = '{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'
REL = '{http://schemas.openxmlformats.org/package/2006/relationships}'
MAX_RANGES = 200


def column_name(number: int) -> str:
    name = ''
    while number:
        number, remainder = divmod(number - 1, 26)
        name = chr(65 + remainder) + name
    return name


def _ranges(numbers: list[int], label=str) -> list[str]:
    out, start, last = [], None, None
    for number in sorted(set(numbers)):
        if start is None:
            start = last = number
        elif number == last + 1:
            last = number
        else:
            out.append(label(start) if start == last else f'{label(start)}–{label(last)}')
            start = last = number
    if start is not None:
        out.append(label(start) if start == last else f'{label(start)}–{label(last)}')
    return out


def _safe(package: zipfile.ZipFile, name: str) -> bytes:
    data = package.read(name)
    if b'<!DOCTYPE' in data[:4096].upper():
        raise ValueError(f'{name} declares a DTD, which workbooks never do')
    return data


def hidden_structure(source: Path) -> list[dict]:
    with zipfile.ZipFile(source) as package:
        names = set(package.namelist())
        if 'xl/workbook.xml' not in names:
            return []
        workbook = ET.fromstring(_safe(package, 'xl/workbook.xml'))
        targets = {}
        if 'xl/_rels/workbook.xml.rels' in names:
            for rel in ET.fromstring(_safe(package, 'xl/_rels/workbook.xml.rels')).iter(REL + 'Relationship'):
                if rel.get('TargetMode') != 'External':
                    target = rel.get('Target', '')
                    targets[rel.get('Id')] = target.lstrip('/') if target.startswith('/') else posixpath.normpath(posixpath.join('xl', target))
        sheets = []
        # Rows are gathered per sheet; a declared range never exceeds Excel's 16,384 columns.
        for sheet in workbook.iter(S + 'sheet'):
            part = targets.get(sheet.get(R + 'id'))
            rows, columns = [], []
            if part in names:
                with package.open(part) as stream:
                    head = stream.read(4096)
                    if b'<!DOCTYPE' in head.upper():
                        raise ValueError(f'{part} declares a DTD, which workbooks never do')
                with package.open(part) as stream:
                    for _, element in ET.iterparse(stream, events=('start',)):
                        if element.tag == S + 'row' and element.get('hidden') in ('1', 'true') and (element.get('r') or '').isdigit():
                            rows.append(int(element.get('r')))
                        elif element.tag == S + 'col' and element.get('hidden') in ('1', 'true') and (element.get('min') or '').isdigit() and (element.get('max') or '').isdigit():
                            columns += range(max(1, int(element.get('min'))), min(16384, int(element.get('max'))) + 1)
                        elif element.tag == S + 'sheetData':
                            element.clear()
            sheets.append({
                'name': sheet.get('name', ''),
                'state': sheet.get('state', 'visible'),
                'hidden_rows': _ranges(rows)[:MAX_RANGES],
                'hidden_columns': _ranges([c for c in columns if 0 < c <= 16384], column_name)[:MAX_RANGES],
                'hidden_rows_truncated': len(_ranges(rows)) > MAX_RANGES,
            })
        return sheets


def summary(sheet: dict, position: int, total: int) -> str:
    lines = [f'Sheet {position} of {total}: {sheet["name"]} · {"visible" if sheet["state"] == "visible" else sheet["state"] + " sheet"}']
    if sheet['hidden_rows']:
        lines.append('Hidden rows: ' + ', '.join(sheet['hidden_rows']) + (' (list truncated)' if sheet['hidden_rows_truncated'] else ''))
    if sheet['hidden_columns']:
        lines.append('Hidden columns: ' + ', '.join(sheet['hidden_columns']))
    if not sheet['hidden_rows'] and not sheet['hidden_columns']:
        lines.append('No hidden rows or columns are declared.')
    return '\n'.join(lines)
