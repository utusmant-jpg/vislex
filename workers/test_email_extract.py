import tempfile
import unittest
from email.message import EmailMessage
from pathlib import Path

from worker import process
from email_extract import html_text


def message(html_only=False):
    msg = EmailMessage()
    msg['From'] = 'Facilities <facilities@synthetic.invalid>'
    msg['To'] = 'review-team@synthetic.invalid'
    msg['Subject'] = 'North door alarm log (SYNTHETIC)'
    msg['Date'] = 'Mon, 14 Sep 2026 15:02:00 +0000'
    if html_only:
        msg.set_content('<html><head><style>p{color:red}</style><script>fetch("https://x.invalid")</script></head>'
                        '<body><p>Two openings&nbsp;at 14:28.</p><img src="https://tracker.invalid/p.png"><p>Fictional.</p></body></html>', subtype='html')
    else:
        msg.set_content('The alarm log shows two openings.\nThis email is fictional test data.\n')
        msg.add_alternative('<p>HTML <b>alternative</b></p>', subtype='html')
        msg.add_attachment(b'synthetic,log\n14:28,open\n', maintype='text', subtype='csv', filename='alarm-log.csv')
    return msg.as_bytes()


class EmailExtraction(unittest.TestCase):
    def run_on(self, data: bytes):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            (job / 'input').write_bytes(data)
            return process(job, {'kind': 'email'})

    def test_headers_plain_body_and_attachment_hash_are_separate_units(self):
        result = self.run_on(message())
        locators = [page['locator'] for page in result['pages']]
        self.assertEqual(locators, ['email:headers', 'email:body:1', 'email:attachment:1'])
        self.assertIn('Subject: North door alarm log (SYNTHETIC)', result['pages'][0]['text'])
        self.assertIn('two openings', result['pages'][1]['text'])
        self.assertNotIn('<p>', ''.join(page['text'] for page in result['pages']))
        attachment = result['metadata']['attachments'][0]
        self.assertEqual(attachment['name'], 'alarm-log.csv')
        self.assertEqual(len(attachment['sha256']), 64)
        self.assertIn(attachment['sha256'], result['pages'][2]['text'])
        self.assertTrue(any('HTML alternative body was not extracted' in note for note in result['limitations']))

    def test_html_only_body_is_reduced_to_visible_text_without_remote_references(self):
        result = self.run_on(message(html_only=True))
        body = result['pages'][1]
        self.assertEqual(body['text'], 'Two openings at 14:28.\n\nFictional.')
        self.assertIn('HTML reduced to text', body['method'])
        joined = ''.join(page['text'] for page in result['pages'])
        for leaked in ('tracker.invalid', 'fetch(', 'color:red'):
            self.assertNotIn(leaked, joined)
        self.assertTrue(result['metadata']['html_reduced_to_text'])

    def test_non_email_bytes_are_refused(self):
        with self.assertRaisesRegex(ValueError, 'does not look like an email'):
            self.run_on(b'just some text\nwithout headers\n')

    def test_html_text_drops_script_and_keeps_blocks(self):
        self.assertEqual(html_text('<div>a</div><script>b</script><p>c &amp; d</p>'), 'a\n\nc & d')


if __name__ == '__main__':
    unittest.main()
