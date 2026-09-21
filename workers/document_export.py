"""Create new text-only documents; never copy source document packages or hidden parts."""
from pathlib import Path
from xml.sax.saxutils import escape


def export(job: Path, request: dict) -> dict:
    kind = request.get('format')
    if kind == 'docx':
        from docx import Document
        document = Document()
        document.add_heading(request['title'], 0)
        document.add_paragraph(request['status'])
        for line in request['content'].splitlines():
            document.add_paragraph(line)
        document.core_properties.author = 'VisLex'
        document.core_properties.comments = ''
        document.save(str(job / 'document.docx'))
    elif kind == 'pdf':
        import reportlab
        from reportlab.pdfbase import pdfmetrics
        from reportlab.pdfbase.ttfonts import TTFont
        from reportlab.lib.styles import ParagraphStyle
        from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
        font = TTFont('VisLexVera', str(Path(reportlab.__file__).parent / 'fonts' / 'Vera.ttf'))
        text = '\n'.join([request['title'], request['status'], request['content']])
        missing = sorted({c for c in text if not c.isspace() and ord(c) not in font.face.charToGlyph})
        if missing:
            raise ValueError('PDF font cannot represent characters: ' + repr(''.join(missing[:20])) + '. Export Word to preserve this text.')
        pdfmetrics.registerFont(font)
        style = ParagraphStyle('Body', fontName='VisLexVera', fontSize=10, leading=15, spaceAfter=7)
        title = ParagraphStyle('Title', parent=style, fontSize=18, leading=23, spaceAfter=16)
        story = [Paragraph(escape(request['title']), title), Paragraph(escape(request['status']), style), Spacer(1, 10)]
        story.extend(Paragraph(escape(line) or '&#160;', style) for line in request['content'].splitlines())
        document = SimpleDocTemplate(str(job / 'document.pdf'), title=request['title'], author='VisLex', leftMargin=50, rightMargin=50, topMargin=50, bottomMargin=50)
        document.build(story)
    else:
        raise ValueError('Unsupported document export format')
    return {'version': 1, 'status': 'complete', 'pages': [], 'metadata': {'format': kind, 'plain_text_only': True}, 'limitations': ['Draft export preserves text, not original layout.'], 'previews': []}
