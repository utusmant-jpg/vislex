import json
import tempfile
import unittest
from pathlib import Path
from worker import json_safe, write_result


class ResultSafetyTests(unittest.TestCase):
    def test_bytes_become_utf8_text_with_replacement(self):
        self.assertEqual(json_safe(b'caf\xc3\xa9 text'), 'café text')
        replaced = json_safe(b'\xff\xfe broken')
        self.assertIsInstance(replaced, str)
        self.assertIn('\ufffd', replaced)

    def test_nested_dicts_lists_and_tuples_are_sanitized_recursively(self):
        payload = {'metadata': {'blob': b'\x00abc', 'streams': [{'time_base': b'1/48000'}]}, 'previews': (b'a', [b'b'])}
        safe = json_safe(payload)
        self.assertEqual(safe['metadata']['blob'], '\x00abc')
        self.assertEqual(safe['metadata']['streams'][0]['time_base'], '1/48000')
        self.assertEqual(safe['previews'], ['a', ['b']])
        self.assertIsInstance(safe['previews'], list)
        json.dumps(safe)

    def test_sets_become_deterministic_safe_strings(self):
        first, second = json_safe({'tiny', 'small'}), json_safe({'small', 'tiny'})
        self.assertIsInstance(first, str)
        self.assertEqual(first, second)
        self.assertIn('tiny', first)
        self.assertIn('small', first)
        json.dumps(first)

    def test_primitives_pass_through_and_other_types_become_repr_strings(self):
        self.assertEqual(json_safe({'kept': [None, True, 3, 2.5, 'text']}), {'kept': [None, True, 3, 2.5, 'text']})
        self.assertEqual(json_safe(float('nan')), 'nan')
        self.assertEqual(json_safe(float('inf')), 'inf')
        marker = object()
        self.assertEqual(json_safe(marker), repr(marker))

    def test_write_result_publishes_unserializable_payload_as_valid_json(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            write_result(job, {'version': 1, 'status': 'complete', 'metadata': {'blob': b'\xff\xfe', 'codecs': {'aac'}}, 'previews': []})
            result = json.loads((job / 'result.json').read_text(encoding='utf-8'))
            self.assertEqual(result['status'], 'complete')
            self.assertIsInstance(result['metadata']['blob'], str)
            self.assertIsInstance(result['metadata']['codecs'], str)
            self.assertNotIn('\ufffd', result['metadata']['codecs'])

    def test_write_result_guard_writes_failed_diagnostic_when_encoding_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            job = Path(directory)
            # A lone surrogate survives the sanitizer as a str but cannot be encoded to UTF-8.
            write_result(job, {'version': 1, 'status': 'complete', 'metadata': {'path': 'a\ud800b'}})
            result = json.loads((job / 'result.json').read_text(encoding='utf-8'))
            self.assertEqual(result['status'], 'failed')
            self.assertIn('UnicodeEncodeError', result['error'])
            self.assertTrue(result['error'])


if __name__ == '__main__':
    unittest.main()
