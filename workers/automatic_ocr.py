"""Offline OCR with bundled model weights; results retain page coordinates and raw scores."""
from functools import lru_cache
import numpy as np

@lru_cache(maxsize=1)
def engine():
    from rapidocr_onnxruntime import RapidOCR
    return RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1)

def recognize(image, locator):
    rgb = image.convert('RGB')
    rows, _ = engine()(np.asarray(rgb)[:, :, ::-1])
    blocks = [{'polygon': np.asarray(box).tolist(), 'text': str(text), 'raw_score': float(score)} for box, text, score in (rows or [])]
    return {'locator': locator, 'text': '\n'.join(row['text'] for row in blocks), 'method': 'RapidOCR 1.4.4 / bundled PP-OCRv4', 'image_size': list(rgb.size), 'blocks': blocks, 'score_is_probability': False}

def pdf_pages(source):
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(str(source))
    try:
        for index in range(len(doc)):
            page = doc[index]
            bitmap = page.render(scale=min(2.0, 2500 / max(page.get_size())))
            try:
                result = recognize(bitmap.to_pil(), f'page:{index + 1}:ocr')
                result['physical_page'] = index + 1
                result['page_size_points'] = list(page.get_size())
                yield result
            finally:
                bitmap.close(); page.close()
    finally:
        doc.close()

def image_pages(source):
    from PIL import Image, ImageOps
    with Image.open(source) as image:
        for index in range(getattr(image, 'n_frames', 1)):
            image.seek(index)
            yield recognize(ImageOps.exif_transpose(image), f'image-frame:{index + 1}:ocr')
