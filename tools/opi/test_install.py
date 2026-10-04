#!/usr/bin/env python3
"""Hermetic copy-install tests; no model calls or home-directory writes."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='opi install ')
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.env = dict(os.environ, XDG_DATA_HOME=str(self.root / 'data'))
        self.binary = self.root / 'bin/opi'

    def install(self):
        return subprocess.run([sys.executable, str(HERE / 'install.py'), '--bin-dir', str(self.binary.parent)],
                              env=self.env, capture_output=True, text=True)

    def test_install_launch_and_update_preserve_history_and_mpi(self):
        self.binary.parent.mkdir()
        mpi = self.binary.with_name('mpi')
        mpi.write_text('existing mpi')
        history = self.root / 'data/optchat/main'
        history.mkdir(parents=True)
        log = history / 'test.jsonl'
        log.write_text('private history sentinel')
        for _ in range(2):
            result = self.install()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(os.access(self.binary, os.X_OK))
            launch = subprocess.run([str(self.binary), '--help'], env=self.env, capture_output=True, text=True)
            self.assertEqual(launch.returncode, 0, launch.stderr)
            self.assertIn('--compact-model', launch.stdout)
            self.assertEqual(log.read_text(), 'private history sentinel')
            self.assertEqual(mpi.read_text(), 'existing mpi')

    def test_existing_command_is_not_overwritten(self):
        self.binary.parent.mkdir()
        self.binary.write_text('someone else owns this')
        result = self.install()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.binary.read_text(), 'someone else owns this')
        self.assertFalse((self.root / 'data/agent-stuff').exists())

    def test_existing_unmanaged_application_directory_is_not_overwritten(self):
        application = self.root / 'data/agent-stuff/opi'
        application.mkdir(parents=True)
        sentinel = application / 'mine'
        sentinel.write_text('keep')
        self.assertNotEqual(self.install().returncode, 0)
        self.assertEqual(sentinel.read_text(), 'keep')
        self.assertFalse(self.binary.exists())


if __name__ == '__main__':
    unittest.main()
