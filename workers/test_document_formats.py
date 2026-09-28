import tempfile
import unittest
import zipfile
from pathlib import Path
from docx import Document
from reportlab.pdfgen import canvas
from openpyxl import Workbook
from worker import process


class DocumentFormats(unittest.TestCase):
    def test_xlsx_formula_and_cached_rows_iterate_in_one_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            job=Path(directory)
            workbook=Workbook()
            sheet=workbook.active
            for row in range(1,201):
                sheet.cell(row,1,row)
                sheet.cell(row,2,f'=A{row}*2')
            workbook.save(job/'input')
            result=process(job,{'kind':'xlsx'})
            self.assertEqual(len(result['pages']),400)
            self.assertEqual(result['pages'][-1]['locator'],f'sheet:{sheet.title}!B200')
            self.assertIn('Cached value: None',result['pages'][-1]['text'])
            self.assertIn('may be stale or absent',result['limitations'][0])

    def test_pdf_probe_then_page_render_uses_physical_count_and_individual_geometry(self):
        with tempfile.TemporaryDirectory() as directory:
            job=Path(directory)
            source=job/'mixed.pdf'
            document=canvas.Canvas(str(source),pagesize=(612,792))
            document.drawString(72,700,'Portrait page')
            document.showPage()
            document.setPageSize((792,612))
            document.drawString(72,500,'Landscape page')
            document.save()
            probe=process(job,{'kind':'pdf_probe','source_lease':str(source)})
            self.assertEqual(probe['metadata']['page_count'],2)
            self.assertEqual(probe['metadata']['first_page_size_points'],[612.0,792.0])
            first=process(job,{'kind':'pdf_page','source_lease':str(source),'page':1})
            second=process(job,{'kind':'pdf_page','source_lease':str(source),'page':2})
            self.assertEqual(first['previews'][0]['page_size_points'],[612.0,792.0])
            self.assertEqual(second['previews'][0]['page_size_points'],[792.0,612.0])
            with self.assertRaisesRegex(ValueError,'outside the document'):
                process(job,{'kind':'pdf_page','source_lease':str(source),'page':12})

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
