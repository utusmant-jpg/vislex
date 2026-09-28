"""Text units from a single RFC 822 message (.eml), using only the stdlib.

Nothing is rendered and nothing is fetched: HTML bodies are reduced to text
with ``html.parser`` (scripts, styles and remote references are dropped, never
requested). Attachments are listed with their declared name, type, size and
SHA-256 so a reviewer can match them, but they are not unpacked or imported;
they stay inside the preserved original.
"""
import hashlib
from email import policy
from email.parser import BytesParser
from html.parser import HTMLParser
from pathlib import Path

MAX_MESSAGE_BYTES = 64 * 1024 * 1024
MAX_PARTS = 500
HEADERS = ('From', 'Sender', 'Reply-To', 'To', 'Cc', 'Bcc', 'Date', 'Subject', 'Message-ID', 'In-Reply-To', 'References')


class _Text(HTMLParser):
    """Visible text of an HTML body. Block elements become line breaks."""
    SKIP = {'script', 'style', 'head', 'title', 'template', 'noscript'}
    BLOCK = {'p', 'div', 'br', 'tr', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'table', 'hr', 'pre'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skipping = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.skipping += 1
        elif tag in self.BLOCK:
            self.parts.append('\n')

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self.skipping = max(0, self.skipping - 1)
        elif tag in self.BLOCK:
            self.parts.append('\n')

    def handle_data(self, data):
        if not self.skipping:
            self.parts.append(data)

    def text(self) -> str:
        lines = [' '.join(line.split()) for line in ''.join(self.parts).splitlines()]
        out: list[str] = []
        for line in lines:
            if line or (out and out[-1]):
                out.append(line)
        return '\n'.join(out).strip()


def html_text(markup: str) -> str:
    parser = _Text()
    parser.feed(markup)
    parser.close()
    return parser.text()


def _content(part) -> str:
    try:
        return part.get_content()
    except (LookupError, UnicodeError, ValueError):
        payload = part.get_payload(decode=True) or b''
        return payload.decode('utf-8', errors='replace')


def extract(job: Path, request: dict) -> dict:
    source = Path(request.get('source_lease') or (job / 'input'))
    if source.stat().st_size > MAX_MESSAGE_BYTES:
        raise ValueError('Email is larger than the 64 MB extraction limit; the original is preserved')
    with source.open('rb') as handle:
        message = BytesParser(policy=policy.default).parse(handle)
    if not any(message.get(name) for name in ('From', 'To', 'Subject', 'Date', 'Message-ID')):
        raise ValueError('This file does not look like an email message (no From, To, Subject, Date or Message-ID header)')

    pages: list[dict] = []
    header_lines = []
    for name in HEADERS:
        for value in message.get_all(name, []):
            header_lines.append(f'{name}: {" ".join(str(value).split())}')
    pages.append({'locator': 'email:headers', 'text': '\n'.join(header_lines), 'method': 'stdlib email headers'})

    parts = list(message.walk())
    if len(parts) > MAX_PARTS:
        raise ValueError(f'Email has more than {MAX_PARTS} MIME parts; no partial extraction published')
    plain = [p for p in parts if p.get_content_type() == 'text/plain' and not p.is_attachment()]
    html = [p for p in parts if p.get_content_type() == 'text/html' and not p.is_attachment()]
    converted = False
    bodies = [(p, _content(p)) for p in plain]
    if not bodies and html:
        # Only HTML exists: keep its visible text, never its markup or remote references.
        bodies = [(p, html_text(_content(p))) for p in html]
        converted = True
    for number, (_, text) in enumerate(bodies, 1):
        pages.append({'locator': f'email:body:{number}', 'text': text.strip(), 'method': 'stdlib email body' + (' (HTML reduced to text)' if converted else '')})

    attachments = []
    for part in parts:
        if part.is_multipart() or not (part.is_attachment() or (part.get_filename() and part not in plain and part not in html)):
            continue
        payload = part.get_payload(decode=True) or b''
        entry = {
            'name': part.get_filename() or '(unnamed)',
            'mime': part.get_content_type(),
            'size': len(payload),
            'sha256': hashlib.sha256(payload).hexdigest(),
        }
        attachments.append(entry)
        pages.append({
            'locator': f'email:attachment:{len(attachments)}',
            'text': f"Attachment: {entry['name']}\nType: {entry['mime']}\nSize: {entry['size']} bytes\nSHA-256: {entry['sha256']}",
            'method': 'stdlib email attachment listing',
        })

    metadata = {
        'kind': 'email',
        'parts': len(parts),
        'plain_bodies': len(plain),
        'html_bodies': len(html),
        'html_reduced_to_text': converted,
        'attachments': attachments,
    }
    notes = [
        'Headers are as written in the message and are not authenticated; dates and senders can be forged.',
        'Remote images and links were not fetched. HTML formatting is not shown.' if html else 'No HTML body was present.',
        'Attachments are listed with their SHA-256 but not opened or imported; they remain inside the preserved original.' if attachments else 'No attachments were declared.',
    ]
    if plain and html:
        notes.append('The HTML alternative body was not extracted because a plain-text body exists; the two can differ.')
    return {'version': 1, 'status': 'complete', 'pages': pages, 'metadata': metadata, 'limitations': notes, 'previews': []}
