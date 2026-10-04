#!/usr/bin/env python3
"""Hermetic launcher and installer checks: no model or network calls."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("mpi_install", HERE / "install.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class MpiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="mpi test ")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.env = dict(os.environ, XDG_DATA_HOME=str(self.root / "data"),
                        MPI_MEMORY_DIR=str(self.root / "private memory"),
                        MPI_MEMO=str(self.root / "memo tool"),
                        MEMORY_DIR="must-not-use", PATH=str(self.bin) + os.pathsep + os.environ["PATH"])
        self.output = self.root / "args.json"
        # Absolute interpreter paths make test doubles independent of PATH.
        (self.bin / "pi").write_text(
            f"#!{sys.executable}\nimport json,os,sys\n"
            f"open({str(self.output)!r}, 'w').write(json.dumps([sys.argv[1:], os.environ['MEMORY_DIR'], os.getcwd()]))\n"
            "sys.exit(17)\n")
        (self.bin / "pi").chmod(0o755)
        Path(self.env["MPI_MEMO"]).write_text(
            "import os\nfrom pathlib import Path\n"
            "p=Path(os.environ['MEMORY_DIR']); p.mkdir(parents=True,exist_ok=True)\n"
            "with (p/'LOG.txt').open('a') as f: pass\n")

    def run_wrapper(self, *args):
        return subprocess.run([sys.executable, str(HERE / "mpi"), *args],
                              env=self.env, cwd=self.root, capture_output=True, text=True)

    def test_launch_preserves_arguments_cwd_exit_and_private_store(self):
        args = ["--model", "test model", "a prompt with 'quotes' and $dollars"]
        result = self.run_wrapper(*args)
        self.assertEqual(result.returncode, 17, result.stderr)
        argv, memory, cwd = json.loads(self.output.read_text())
        self.assertEqual(argv[0], "--append-system-prompt")
        self.assertIn(" wake", argv[1])
        self.assertIn("'" + self.env["MPI_MEMO"] + "'", argv[1])
        self.assertEqual(argv[2:], args)
        self.assertEqual(memory, self.env["MPI_MEMORY_DIR"])
        self.assertEqual(cwd, str(self.root))
        store = Path(memory)
        self.assertEqual(store.stat().st_mode & 0o777, 0o700)
        (store / "LOG.txt").write_text("retained")
        self.assertEqual(self.run_wrapper().returncode, 17)
        self.assertEqual((store / "LOG.txt").read_text(), "retained")

    def test_missing_tool_does_not_launch_pi(self):
        Path(self.env["MPI_MEMO"]).unlink()
        self.assertNotEqual(self.run_wrapper().returncode, 0)
        self.assertFalse(self.output.exists())

    def test_init_failure_does_not_launch_pi(self):
        Path(self.env["MPI_MEMO"]).write_text("import sys; sys.exit('broken store')")
        result = self.run_wrapper()
        self.assertIn("broken store", result.stderr)
        self.assertFalse(self.output.exists())

    def install(self, content, expected):
        source = self.root / "download"
        source.write_bytes(content)
        with patch.dict(os.environ, self.env), patch.object(installer, "SHA256", expected), \
             patch.object(sys, "argv", ["install.py", "--bin-dir", str(self.bin), "--optmem-source", str(source)]), \
             contextlib.redirect_stdout(io.StringIO()):
            installer.main()

    def test_install_and_reinstall_preserve_memory(self):
        content = b"# verified tool\n"
        digest = hashlib.sha256(content).hexdigest()
        self.install(content, digest)
        store = self.root / "data/mpi/memory"
        store.mkdir()
        (store / "LOG.txt").write_text("keep")
        self.install(content, digest)
        self.assertEqual((store / "LOG.txt").read_text(), "keep")
        self.assertEqual((self.root / "data/mpi/memo").read_bytes(), content)
        self.assertTrue(os.access(self.bin / "mpi", os.X_OK))

    def test_checksum_failure_writes_nothing(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.install(b"wrong content", "0" * 64)
        self.assertFalse((self.root / "data").exists())
        self.assertFalse((self.bin / "mpi").exists())

    def test_unrelated_command_is_preserved(self):
        (self.bin / "mpi").write_text("existing command")
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.install(b"tool", hashlib.sha256(b"tool").hexdigest())
        self.assertEqual((self.bin / "mpi").read_text(), "existing command")
        self.assertFalse((self.root / "data").exists())


if __name__ == "__main__":
    unittest.main()
