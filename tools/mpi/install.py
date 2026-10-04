#!/usr/bin/env python3
"""Install mpi and a verified OptMem snapshot; never modify memory."""
import argparse
import hashlib
import os
from pathlib import Path
import tempfile
import urllib.request

REVISION = "1fb164cf39028047781f72ac3bb1e5a691c1dcb0"
SHA256 = "3dc120d01be3115ef6267eab4103e7909fc830d6227b549f20991ba999ee9ffb"
URL = f"https://raw.githubusercontent.com/VictorTaelin/OptMem/{REVISION}/memo"


def write_atomic(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    name = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
            name = f.name
            f.write(content)
        os.chmod(name, 0o755)
        os.replace(name, path)
    finally:
        if name and os.path.exists(name):
            os.unlink(name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bin-dir", type=Path, default=Path.home() / ".local/bin")
    parser.add_argument("--optmem-source", type=Path,
                        help="Use a local memo file instead of downloading (same checksum required)")
    args = parser.parse_args()
    if args.optmem_source:
        memo = args.optmem_source.read_bytes()
    else:
        with urllib.request.urlopen(URL, timeout=60) as response:
            memo = response.read()
    if hashlib.sha256(memo).hexdigest() != SHA256:
        parser.exit(1, "OptMem checksum mismatch; nothing installed.\n")
    wrapper = Path(__file__).with_name("mpi").read_bytes()
    data = Path(os.environ.get("XDG_DATA_HOME", str(Path.home() / ".local/share"))) / "mpi"
    destination = args.bin_dir.expanduser().resolve() / "mpi"
    # Only replace a prior copy of our wrapper, never an unrelated command.
    if destination.exists() or destination.is_symlink():
        if destination.is_symlink() or not destination.is_file() or b'"""Launch Pi with a separate, persistent OptMem store."""' not in destination.read_bytes():
            parser.exit(1, f"Refusing to replace unrelated command: {destination}\n")
    write_atomic(data / "memo", memo)
    write_atomic(destination, wrapper)
    print(f"Installed {destination}\nOptMem revision: {REVISION}\nMemory on first launch: {data / 'memory'}")
    print(f"Ensure {destination.parent} is on PATH, then run mpi.")


if __name__ == "__main__":
    main()
