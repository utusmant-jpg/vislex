import tempfile
import unittest
import zipfile
from pathlib import Path

from docx import Document
from worker import process

W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'


def rewrite(path: Path, edits: dict):
    with zipfile.ZipFile(path) as archive:
        files = {name: archive.read(name) for name in archive.namelist()}
    for name, change in edits.items():
        files[name] = change(files.get(name, b'').decode()).encode()
    with zipfile.ZipFile(path, 'w') as archive:
        for name, data in files.items():
            archive.writestr(name, data)


class DocxExtraction(unittest.TestCase):
    def build(self, job: Path):
        document = Document()
        document.add_paragraph('Base text')
        document.add_paragraph('Second paragraph')
        document.sections[0].header.paragraphs[0].text = 'SYNTHETIC header'
        document.save(job / 'input')
        tracked = ('<w:r><w:t xml:space="preserve">Base </w:t></w:r>'
                   '<w:ins w:id="1" w:author="Reviewer A" w:date="2026-09-14T10:00:00Z"><w:r><w:t xml:space="preserve">INSERTED </w:t></w:r></w:ins>'
                   '<w:del w:id="2" w:author="Reviewer B" w:date="2026-09-14T11:00:00Z"><w:r><w:delText xml:space="preserve">DELETED </w:delText></w:r></w:del>'
                   '<w:r><w:t>text</w:t></w:r>')
        comments = (f'<?xml version="1.0" encoding="UTF-8"?><w:comments xmlns:w="{W}">'
                    '<w:comment w:id="7" w:author="Reviewer C" w:date="2026-09-15T09:00:00Z"><w:p><w:r><w:t>Check the clock (SYNTHETIC)</w:t></w:r></w:p></w:comment></w:comments>')
        footnotes = (f'<?xml version="1.0" encoding="UTF-8"?><w:footnotes xmlns:w="{W}">'
                     '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>'
                     '<w:footnote w:id="1"><w:p><w:r><w:t>Fictional footnote.</w:t></w:r></w:p></w:footnote></w:footnotes>')
        rewrite(job / 'input', {
            'word/document.xml': lambda xml: xml.replace('<w:r><w:t>Base text</w:t></w:r>', tracked),
            'word/comments.xml': lambda _: comments,
            'word/footnotes.xml': lambda _: footnotes,
        })

    def test_tracked_insertions_are_kept_and_every_change_is_listed(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            self.build(job)
            result = process(job, {'kind': 'docx'})
            units = {page['locator']: page['text'] for page in result['pages']}
            self.assertEqual(units['block:1:paragraph'], 'Base INSERTED text')
            self.assertEqual(units['block:2:paragraph'], 'Second paragraph')
            changes = units['block:1:tracked-changes']
            self.assertIn('Inserted by Reviewer A (2026-09-14T10:00:00Z): INSERTED', changes)
            self.assertIn('Deleted by Reviewer B (2026-09-14T11:00:00Z): DELETED', changes)
            self.assertEqual(units['comment:7'], 'Comment by Reviewer C (2026-09-15T09:00:00Z):\nCheck the clock (SYNTHETIC)')
            self.assertEqual(units['header:1'], 'Header: SYNTHETIC header')
            self.assertEqual(units['footnote:1'], 'Footnote 1: Fictional footnote.')
            self.assertNotIn('footnote:-1', units)
            self.assertEqual(result['metadata']['tracked_changes'], 2)
            self.assertEqual(result['metadata']['comments'], 1)
            self.assertIn('not authenticated', result['limitations'][0])

    def test_tabs_and_breaks_survive(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            Document().save(job / 'input')
            rewrite(job / 'input', {'word/document.xml': lambda xml: xml.replace('<w:body>', '<w:body><w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br/><w:t>c</w:t></w:r></w:p>', 1)})
            result = process(job, {'kind': 'docx'})
            self.assertEqual(result['pages'][0]['text'], 'a\tb\nc')

    def test_non_word_zip_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            with zipfile.ZipFile(job / 'input', 'w') as archive:
                archive.writestr('other.xml', '<x/>')
            with self.assertRaisesRegex(ValueError, 'Not a Word document'):
                process(job, {'kind': 'docx'})

    def test_dtd_declarations_are_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            Document().save(job / 'input')
            rewrite(job / 'input', {'word/document.xml': lambda xml: xml.replace('?>', '?><!DOCTYPE d [<!ENTITY e "x">]>', 1)})
            with self.assertRaisesRegex(ValueError, 'declares a DTD'):
                process(job, {'kind': 'docx'})


if __name__ == '__main__':
    unittest.main()
