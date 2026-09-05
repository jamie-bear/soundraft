"""Read-only preflight must reject unsafe backups before Compose can be called."""
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest

VALIDATOR = Path(__file__).with_name('validate-restore.py')

class RestoreValidation(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='soundraft-restore-test-')
        self.root = Path(self.temp.name)
        self.backup = self.root / 'backup'
        self.backup.mkdir()
        (self.backup / 'database.dump').write_bytes(b'test dump')
        (self.backup / 'inventory.jsonl').write_text('{}\n')
        (self.backup / 'manifest.json').write_text(json.dumps({'format_version': 3}))
        self.archive('bucket/file')
    def tearDown(self):
        self.temp.cleanup()
    def archive(self, name, symlink=False):
        with tarfile.open(self.backup / 'storage.tar.gz', 'w:gz') as archive:
            member = tarfile.TarInfo(name)
            if symlink:
                member.type = tarfile.SYMTYPE
                member.linkname = '../../outside'
                archive.addfile(member)
            else:
                member.size = 4
                archive.addfile(member, io.BytesIO(b'data'))
        self.checksums()
    def checksums(self):
        names = ['database.dump', 'storage.tar.gz', 'manifest.json', 'inventory.jsonl']
        (self.backup / 'SHA256SUMS').write_text(''.join(f'{hashlib.sha256((self.backup / name).read_bytes()).hexdigest()}  {name}\n' for name in names))
    def run_validation(self, pg=None, storage=None, override=None):
        return subprocess.run([sys.executable, str(VALIDATOR), str(self.backup),
            str(pg or self.root / 'pg'), str(storage or self.root / 'storage'),
            str(override or self.root / 'targets.json')], capture_output=True, text=True)
    def test_valid_snapshot_produces_persistent_override(self):
        result = self.run_validation()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('services', json.loads((self.root / 'targets.json').read_text()))
    def test_rejects_equal_or_nested_data_targets(self):
        for storage in [self.root / 'pg', self.root / 'pg' / 'storage']:
            self.assertNotEqual(self.run_validation(storage=storage).returncode, 0)
    def test_rejects_backup_overlap_and_existing_data(self):
        self.assertNotEqual(self.run_validation(pg=self.backup / 'pg').returncode, 0)
        existing = self.root / 'existing'
        existing.mkdir()
        (existing / 'keep').write_text('important')
        self.assertNotEqual(self.run_validation(pg=existing).returncode, 0)
        self.assertEqual((existing / 'keep').read_text(), 'important')
    def test_rejects_archive_traversal_and_links(self):
        for name, symlink in [('../escape', False), ('/absolute', False), ('link', True)]:
            self.archive(name, symlink)
            self.assertNotEqual(self.run_validation().returncode, 0)
            self.assertFalse((self.root / 'targets.json').exists())
    def test_rejects_corruption_and_incomplete_checksums(self):
        (self.backup / 'database.dump').write_bytes(b'corrupt')
        self.assertNotEqual(self.run_validation().returncode, 0)
        self.checksums()
        (self.backup / 'SHA256SUMS').write_text('')
        self.assertNotEqual(self.run_validation().returncode, 0)
    def test_rejects_override_inside_database(self):
        self.assertNotEqual(self.run_validation(override=self.root / 'pg' / 'targets.json').returncode, 0)

if __name__ == '__main__':
    unittest.main()
