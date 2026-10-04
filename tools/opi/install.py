#!/usr/bin/env python3
"""Copy opi into the user's local data/bin directories. No model calls."""
import argparse
import os
from pathlib import Path
import shutil
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bin-dir', type=Path, default=Path.home() / '.local/bin')
    args = parser.parse_args()
    source = Path(__file__).resolve().parent
    data = Path(os.environ.get('XDG_DATA_HOME', str(Path.home() / '.local/share'))).expanduser().resolve()
    destination = data / 'agent-stuff' / 'opi'
    binary = args.bin_dir.expanduser().resolve() / 'opi'
    marker = '# agent-stuff OptChat launcher'
    if binary.exists() or binary.is_symlink():
        if binary.is_symlink() or not binary.is_file() or marker not in binary.read_text():
            parser.exit(1, f'Refusing to replace unrelated command: {binary}\n')
    if destination.exists() and not (destination / '.agent-stuff-opi').is_file():
        parser.exit(1, f'Refusing to replace unrelated directory: {destination}\n')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=destination.parent) as staging:
        stage = Path(staging) / 'opi'
        shutil.copytree(source, stage, ignore=shutil.ignore_patterns('__pycache__', 'test', 'node_modules'))
        (stage / '.agent-stuff-opi').write_text('Managed by agent-stuff/tools/opi/install.py\n')
        # Never modify the separate optchat/ history directory during installation.
        if destination.exists():
            old = Path(staging) / 'previous'
            destination.rename(old)
            try:
                stage.rename(destination)
            except BaseException:
                old.rename(destination)
                raise
        else:
            stage.rename(destination)
    binary.parent.mkdir(parents=True, exist_ok=True)
    # Python builds argv directly; paths and user arguments never pass through a shell.
    wrapper = '#!/usr/bin/env python3\n' + marker + '\nimport os, sys\nos.execvp("node", ["node", ' + repr(str(destination / 'opi.mjs')) + ', *sys.argv[1:]])\n'
    with tempfile.NamedTemporaryFile(mode='w', dir=binary.parent, delete=False) as f:
        f.write(wrapper)
        temporary = f.name
    os.chmod(temporary, 0o755)
    os.replace(temporary, binary)
    print(f'Installed {binary}\nRequires Node 22+ and Pi 0.87.1 (npm installation).\nRun opi --doctor, then opi. mpi is unchanged.')


if __name__ == '__main__':
    main()
