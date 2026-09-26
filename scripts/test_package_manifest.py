import os
import subprocess
import sys
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

    def test_link_to_outside_folder_is_rejected_when_supported(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            root = base / 'package'
            root.mkdir()
            (root / 'VisLex.exe').write_bytes(b'fixture')
            outside = base / 'private'
            outside.mkdir()
            (outside / 'secret.txt').write_text('never hash me')
            try:
                os.symlink(outside, root / 'outside', target_is_directory=True)
            except OSError as error:
                if sys.platform != 'win32':
                    self.skipTest(f'Symlink creation unavailable: {error}')
                script = base / 'make-junction.ps1'
                script.write_text('param([string]$Target, [string]$Link)\nNew-Item -ItemType Junction -Path $Link -Target $Target | Out-Null\n')
                subprocess.run(['powershell', '-NoProfile', '-File', str(script), '-Target', str(outside), '-Link', str(root / 'outside')], check=True)
            with self.assertRaisesRegex(ValueError, 'link or reparse point'):
                write(root, 'c' * 40)


if __name__ == '__main__':
    unittest.main()
