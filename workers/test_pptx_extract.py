import tempfile
import unittest
import zipfile
from pathlib import Path

from worker import process

NS = ('xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
      'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')
RELS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"'
NOTES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide'


def slide(text, hidden=False):
    show = ' show="0"' if hidden else ''
    return f'<p:sld {NS}{show}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'


def notes(text):
    return (f'<p:notes {NS}><p:cSld><p:spTree>'
            '<p:sp><p:nvSpPr><p:cNvPr id="2" name="img"/><p:cNvSpPr/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp>'
            f'<p:sp><p:nvSpPr><p:cNvPr id="3" name="body"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:txBody></p:sp>'
            '<p:sp><p:nvSpPr><p:cNvPr id="4" name="num"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>9</a:t></a:r></a:p></p:txBody></p:sp>'
            '</p:spTree></p:cSld></p:notes>')


class PptxExtraction(unittest.TestCase):
    def test_presentation_order_hidden_slides_and_speaker_notes(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            with zipfile.ZipFile(job / 'input', 'w') as archive:
                # Part numbers disagree with the shown order: slide2 is shown first.
                archive.writestr('ppt/presentation.xml', f'<p:presentation {NS}><p:sldIdLst><p:sldId id="256" r:id="rId8"/><p:sldId id="257" r:id="rId7"/></p:sldIdLst></p:presentation>')
                archive.writestr('ppt/_rels/presentation.xml.rels', f'<Relationships {RELS}><Relationship Id="rId7" Type="slide" Target="slides/slide1.xml"/><Relationship Id="rId8" Type="slide" Target="slides/slide2.xml"/><Relationship Id="rId9" Type="x" Target="https://remote.invalid" TargetMode="External"/></Relationships>')
                archive.writestr('ppt/slides/slide1.xml', slide('Shown second (SYNTHETIC)', hidden=True))
                archive.writestr('ppt/slides/slide2.xml', slide('Shown first (SYNTHETIC)'))
                archive.writestr('ppt/slides/slide3.xml', slide('Orphan part'))
                archive.writestr('ppt/slides/_rels/slide2.xml.rels', f'<Relationships {RELS}><Relationship Id="rId2" Type="{NOTES}" Target="../notesSlides/notesSlide5.xml"/></Relationships>')
                archive.writestr('ppt/notesSlides/notesSlide5.xml', notes('Say the clock is unverified.'))
            result = process(job, {'kind': 'pptx'})
            units = [(page['locator'], page['text']) for page in result['pages']]
            self.assertEqual(units, [
                ('ppt/slides/slide2.xml:slide', 'Slide 1 of 3 in presentation order'),
                ('ppt/slides/slide2.xml:paragraph:1', 'Shown first (SYNTHETIC)'),
                ('ppt/slides/slide2.xml:notes', 'Speaker notes: Say the clock is unverified.'),
                ('ppt/slides/slide1.xml:slide', 'Slide 2 of 3 in presentation order · hidden in slideshow'),
                ('ppt/slides/slide1.xml:paragraph:1', 'Shown second (SYNTHETIC)'),
                ('ppt/slides/slide3.xml:slide', 'Slide 3 of 3 by part number'),
                ('ppt/slides/slide3.xml:paragraph:1', 'Orphan part'),
            ])
            self.assertEqual(result['metadata'], {'slides': 3, 'hidden_slides': 1, 'slides_with_notes': 1, 'presentation_order': True})

    def test_dtd_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            with zipfile.ZipFile(job / 'input', 'w') as archive:
                archive.writestr('ppt/slides/slide1.xml', '<!DOCTYPE x [<!ENTITY e "y">]>' + slide('&e;'))
            with self.assertRaisesRegex(ValueError, 'declares a DTD'):
                process(job, {'kind': 'pptx'})


if __name__ == '__main__':
    unittest.main()
