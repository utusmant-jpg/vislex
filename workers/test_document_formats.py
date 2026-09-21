import tempfile
import unittest
import zipfile
from pathlib import Path
from docx import Document
from worker import process


class DocumentFormats(unittest.TestCase):
    def test_docx_preserves_table_order(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            document = Document()
            document.add_paragraph("Before table")
            document.add_table(rows=1, cols=1).cell(0, 0).text = "Inside table"
            document.add_paragraph("After table")
            document.save(job / "input")
            result = process(job, {"kind": "docx"})
            self.assertEqual([p["text"] for p in result["pages"]], ["Before table", "Inside table", "After table"])
            self.assertTrue(result["limitations"])

    def test_pptx_numeric_slide_order_and_literal_untrusted_text(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            with zipfile.ZipFile(job / "input", "w") as archive:
                for number in (10, 2, 1):
                    archive.writestr(f"ppt/slides/slide{number}.xml", f'<root xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:p><a:r><a:t>Slide {number} &amp; text</a:t></a:r></a:p></root>')
            result = process(job, {"kind": "pptx"})
            self.assertEqual([p["text"] for p in result["pages"]], ["Slide 1 & text", "Slide 2 & text", "Slide 10 & text"])

    def test_odt_heading_paragraph_and_table_text(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            with zipfile.ZipFile(job / "input", "w") as archive:
                archive.writestr("content.xml", '<root xmlns:t="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><t:h>Heading</t:h><t:p>Some <t:span>text</t:span></t:p><table><t:p>Cell</t:p></table></root>')
            result = process(job, {"kind": "odt"})
            self.assertEqual([p["text"] for p in result["pages"]], ["Heading", "Some text", "Cell"])


if __name__ == "__main__":
    unittest.main()
