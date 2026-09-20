"""Public, generated test fixtures. Contains no real case material."""
from pathlib import Path
from PIL import Image, ImageDraw
from docx import Document
from openpyxl import Workbook

root = Path(__file__).resolve().parent.parent / 'fixtures' / 'generated'
root.mkdir(parents=True, exist_ok=True)
image = Image.new('RGB', (900, 600), '#d4dfd6')
draw = ImageDraw.Draw(image)
draw.rectangle((180, 160, 720, 470), fill='#657d70')
draw.rectangle((350, 220, 530, 470), fill='#203f36')
draw.rectangle((610, 350, 650, 400), fill='#366cb0')
draw.text((25, 25), 'SYNTHETIC TEST IMAGE - NO REAL EVIDENCE', fill='#19372c')
image.save(root / 'photograph.png')
# Minimal authored PDF with a known text stream and correct byte offsets.
stream = b'BT /F1 18 Tf 50 730 Td (SYNTHETIC witness statement) Tj 0 -30 Td (A blue bag was reported. Time remains uncertain.) Tj ET'
objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>', b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream']
pdf = bytearray(b'%PDF-1.4\n'); offsets = [0]
for number, obj in enumerate(objects, 1):
    offsets.append(len(pdf)); pdf.extend(f'{number} 0 obj\n'.encode() + obj + b'\nendobj\n')
xref = len(pdf); pdf.extend(f'xref\n0 {len(objects)+1}\n0000000000 65535 f \n'.encode())
for offset in offsets[1:]: pdf.extend(f'{offset:010d} 00000 n \n'.encode())
pdf.extend(f'trailer\n<< /Size {len(objects)+1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n'.encode())
(root / 'statement.pdf').write_bytes(pdf)
doc = Document(); doc.add_paragraph('SYNTHETIC review notes'); doc.add_paragraph('No identity has been established.'); doc.save(root / 'notes.docx')
book = Workbook(); sheet = book.active; sheet.title = 'Events'; sheet.append(['SYNTHETIC', 'Reported time', 'Uncertainty']); sheet.append(['Witness statement', '14:32', 'Clock not verified']); book.save(root / 'table.xlsx')
(root / 'statement.txt').write_text('SYNTHETIC witness statement\nA blue bag was reported.\nClock alignment remains uncertain.\n', encoding='utf-8')
import av
from fractions import Fraction
with av.open(str(root / 'variable-timing.mp4'), 'w') as container:
    stream = container.add_stream('mpeg4', rate=10)
    stream.width, stream.height = 320, 180
    stream.pix_fmt = 'yuv420p'
    stream.time_base = Fraction(1, 1000)
    stream.codec_context.time_base = Fraction(1, 1000)
    for timestamp in [0, 200, 600, 1400, 2500, 3000]:
        frame_image = Image.new('RGB', (320, 180), '#253c34')
        ImageDraw.Draw(frame_image).text((20, 60), f'SYNTHETIC FRAME / {timestamp} ms', fill='white')
        frame = av.VideoFrame.from_image(frame_image)
        frame.pts, frame.time_base = timestamp, Fraction(1, 1000)
        for packet in stream.encode(frame): container.mux(packet)
    for packet in stream.encode(): container.mux(packet)
