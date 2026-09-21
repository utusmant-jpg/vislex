"""Flatten PDF/image pages into fresh raster derivatives. No original text or attachments copied."""
from pathlib import Path
import math


def redact(job: Path, request: dict) -> dict:
    from PIL import Image, ImageOps, ImageDraw
    Image.MAX_IMAGE_PIXELS = 40_000_000
    boxes = request.get('boxes', [])
    if not isinstance(boxes, list) or not 1 <= len(boxes) <= 1000:
        raise ValueError('Supply 1 to 1000 redaction rectangles')
    for box in boxes:
        if set(box) != {'page', 'x', 'y', 'width', 'height'} or not isinstance(box['page'], int) or box['page'] < 1:
            raise ValueError('Each rectangle requires page, x, y, width and height')
        if any(not isinstance(box[k], (int, float)) or not math.isfinite(box[k]) for k in ('x', 'y', 'width', 'height')):
            raise ValueError('Invalid rectangle coordinates')
        if box['x'] < 0 or box['y'] < 0 or box['width'] <= 0 or box['height'] <= 0:
            raise ValueError('Rectangle is outside the page')
    source = job / 'input'
    document = None
    if request['source_kind'] == 'pdf':
        import pypdfium2 as pdfium
        document = pdfium.PdfDocument(str(source))
        count = len(document)
    elif request['source_kind'] == 'image':
        with Image.open(source) as original:
            if original.width * original.height > 40_000_000:
                raise ValueError('Image exceeds raster redaction limit')
            count = getattr(original, 'n_frames', 1)
        if count != 1:
            raise ValueError('Multipage images must first be converted into explicitly reviewed pages')
    else:
        raise ValueError('This redaction adapter supports PDFs and single-frame images')
    if count > 500 or any(box['page'] > count for box in boxes):
        raise ValueError('Page count or rectangle page exceeds supported bounds')
    previews, pages = [], []
    from reportlab.pdfgen import canvas
    pdf = canvas.Canvas(str(job / 'redacted.pdf'), pageCompression=1)
    pdf.setTitle('Reviewed redaction derivative')
    pdf.setAuthor('VisLex')
    for number in range(1, count + 1):
        if (job / 'cancel.request').exists():
            raise RuntimeError('Redaction cancelled')
        if document is not None:
            page = document[number - 1]
            width, height = page.get_size()
            if width * height * 4 > 40_000_000:
                raise ValueError('Page exceeds raster redaction limit')
            image = page.render(scale=2).to_pil().convert('RGB')
            scale = 2
        else:
            with Image.open(source) as original:
                image = ImageOps.exif_transpose(original).convert('RGB')
            width, height = image.size
            scale = 1
        draw = ImageDraw.Draw(image)
        applied = [box for box in boxes if box['page'] == number]
        for box in applied:
            if box['x'] + box['width'] > width or box['y'] + box['height'] > height:
                raise ValueError(f'Rectangle exceeds page {number} dimensions {width} by {height}')
            # Round outward and mask an extra pixel so no antialiased boundary survives.
            draw.rectangle((max(0, math.floor(box['x'] * scale) - 1), max(0, math.floor(box['y'] * scale) - 1), min(image.width, math.ceil((box['x'] + box['width']) * scale) + 1), min(image.height, math.ceil((box['y'] + box['height']) * scale) + 1)), fill='black')
        filename = f'redacted-{number:04d}.jpg'
        image.save(job / filename, format='JPEG', quality=100, subsampling=0, exif=b'')
        pdf.setPageSize((width, height))
        pdf.drawInlineImage(image, 0, 0, width=width, height=height)
        pdf.showPage()
        previews.append({'path': filename, 'mime': 'image/jpeg', 'page': number, 'redaction': True, 'rectangles': len(applied), 'width': width, 'height': height})
        pages.append({'locator': f'redacted-page:{number}', 'text': f'Rasterized page {number}; {len(applied)} rectangles applied.', 'method': 'fresh raster redaction; not OCR'})
    pdf.save()
    previews.append({'path': 'redacted.pdf', 'mime': 'application/pdf', 'redaction': True, 'page_count': count})
    return {'version': 1, 'status': 'complete', 'pages': pages, 'metadata': {'redaction': True, 'page_count': count, 'boxes': boxes, 'hidden_text_copied': False, 'attachments_copied': False, 'review': 'required'}, 'previews': previews, 'limitations': ['Review every rendered page before export. The system does not discover all sensitive content.', 'PDF coordinates use points from the displayed top-left; image coordinates use orientation-corrected pixels.', 'Originals and original content remain in the private case. Only export the reviewed derivative.']}
