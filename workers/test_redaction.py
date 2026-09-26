"""Synthetic redaction checks against exported bytes, not review metadata."""
import tempfile
import unittest
from pathlib import Path

from PIL import Image
from pypdf import PdfReader, PdfWriter
import pypdfium2 as pdfium
from reportlab.pdfgen import canvas

from redaction import redact


class RedactionOutput(unittest.TestCase):
    def test_pdf_discards_text_attachment_and_source_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            original = job / 'original.pdf'
            pdf = canvas.Canvas(str(original), pagesize=(612, 792))
            pdf.drawString(72, 700, 'SYNTHETIC SECRET 4827')
            pdf.save()
            writer = PdfWriter()
            writer.append(PdfReader(original))
            writer.add_metadata({'/Subject': 'SYNTHETIC PRIVATE METADATA'})
            writer.add_attachment('synthetic-secret.txt', b'SYNTHETIC PRIVATE ATTACHMENT')
            with (job / 'input').open('wb') as target:
                writer.write(target)

            result = redact(job, {'source_kind': 'pdf', 'boxes': [
                {'page': 1, 'x': 65, 'y': 72, 'width': 220, 'height': 36}
            ]})
            output = PdfReader(job / 'redacted.pdf')
            self.assertEqual(len(output.pages), 1)
            self.assertEqual(output.pages[0].extract_text(), '')
            self.assertFalse(output.attachments)
            self.assertNotIn('SYNTHETIC PRIVATE METADATA', str(output.metadata))
            self.assertNotIn(b'SYNTHETIC PRIVATE ATTACHMENT', (job / 'redacted.pdf').read_bytes())
            self.assertEqual(result['metadata']['page_count'], 1)
            with Image.open(job / 'redacted-0001.jpg') as preview:
                self.assertEqual(preview.size, (1224, 1584))
                # The source text baseline is inside the outward-rounded mask.
                self.assertLess(max(preview.getpixel((x, y))[0] for x in range(160, 560) for y in range(170, 205)), 10)

    def test_wrong_page_and_out_of_bounds_rectangles_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            pdf = canvas.Canvas(str(job / 'input'), pagesize=(612, 792))
            pdf.drawString(72, 700, 'Page one')
            pdf.save()
            with self.assertRaisesRegex(ValueError, 'Page count'):
                redact(job, {'source_kind': 'pdf', 'boxes': [
                    {'page': 2, 'x': 1, 'y': 1, 'width': 20, 'height': 20}
                ]})
            with self.assertRaisesRegex(ValueError, 'exceeds page'):
                redact(job, {'source_kind': 'pdf', 'boxes': [
                    {'page': 1, 'x': 610, 'y': 1, 'width': 20, 'height': 20}
                ]})

    def test_rotated_pdf_uses_displayed_page_geometry(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            original = job / 'original.pdf'
            pdf = canvas.Canvas(str(original), pagesize=(200, 100))
            pdf.drawString(20, 60, 'ROTATED PAGE')
            pdf.save()
            writer = PdfWriter()
            writer.append(PdfReader(original))
            writer.pages[0].rotate(90)
            with (job / 'input').open('wb') as target:
                writer.write(target)
            with pdfium.PdfDocument(str(job / 'input')) as document:
                page = document[0]
                try:
                    displayed = page.get_size()
                    bitmap = page.render(scale=2)
                    try:
                        rendered_size = bitmap.to_pil().size
                    finally:
                        bitmap.close()
                finally:
                    page.close()
            redact(job, {'source_kind': 'pdf', 'boxes': [
                {'page': 1, 'x': 0, 'y': 0, 'width': 20, 'height': 20}
            ]})
            with Image.open(job / 'redacted-0001.jpg') as preview:
                self.assertEqual(preview.size, rendered_size)
                self.assertEqual(preview.size, (round(displayed[0] * 2), round(displayed[1] * 2)))
                self.assertLess(max(preview.getpixel((x, y))[0] for x in range(5, 35) for y in range(5, 35)), 10)

    def test_exif_orientation_is_applied_before_image_coordinates(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            image = Image.new('RGB', (100, 50), 'white')
            exif = image.getexif()
            exif[274] = 6
            image.save(job / 'input', format='JPEG', exif=exif)
            image.close()
            redact(job, {'source_kind': 'image', 'boxes': [
                {'page': 1, 'x': 0, 'y': 0, 'width': 20, 'height': 20}
            ]})
            with Image.open(job / 'redacted-0001.jpg') as preview:
                self.assertEqual(preview.size, (50, 100))
                self.assertLess(max(preview.getpixel((x, y))[0] for x in range(5, 18) for y in range(5, 18)), 10)

    def test_cancelled_multipage_job_releases_input_and_publishes_no_pdf(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            pdf = canvas.Canvas(str(job / 'input'), pagesize=(200, 100))
            for page in range(3):
                pdf.drawString(20, 60, f'Page {page + 1}')
                pdf.showPage()
            pdf.save()
            (job / 'cancel.request').touch()
            with self.assertRaisesRegex(RuntimeError, 'cancelled'):
                redact(job, {'source_kind': 'pdf', 'boxes': [
                    {'page': 1, 'x': 10, 'y': 10, 'width': 50, 'height': 20}
                ]})
            self.assertFalse((job / 'redacted-0001.jpg').exists())
            self.assertFalse((job / 'redacted.pdf').exists())
            # Windows rejects deletion if PDFium still holds the source handle.


if __name__ == '__main__':
    unittest.main()
