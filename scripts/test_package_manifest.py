import tempfile
import unittest
from pathlib import Path

from package_manifest import verify, write


class PackageManifestTests(unittest.TestCase):
    def test_round_trip_and_tamper_detection(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'VisLex.exe').write_bytes(b'fixture executable')
            (root / 'resources').mkdir()
            (root / 'resources' / 'worker.bin').write_bytes(b'fixture worker')
            write(root, 'a' * 40)
            self.assertEqual(verify(root)['commit'], 'a' * 40)
            (root / 'resources' / 'worker.bin').write_bytes(b'changed worker')
            with self.assertRaisesRegex(ValueError, 'changed='):
                verify(root)

    def test_extra_file_and_second_write_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'VisLex.exe').write_bytes(b'fixture')
            write(root, 'b' * 40)
            with self.assertRaisesRegex(ValueError, 'already exists'):
                write(root, 'b' * 40)
            (root / 'unexpected.txt').write_text('extra')
            with self.assertRaisesRegex(ValueError, 'extra='):
                verify(root)


if __name__ == '__main__':
    unittest.main()
