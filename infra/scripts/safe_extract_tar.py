#!/usr/bin/env python3
"""Extract a gzip tar archive without links, devices, ownership, or path escape."""

from __future__ import annotations

import shutil
import sys
import tarfile
from pathlib import Path, PurePosixPath


def _relative_path(name: str) -> Path:
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or ".." in path.parts:
        raise ValueError(f"unsafe archive path: {name!r}")
    return Path(*path.parts)


def extract(archive: Path, destination: Path) -> None:
    root = destination.resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)

    with tarfile.open(archive, mode="r:gz") as source:
        members = source.getmembers()
        targets: set[Path] = set()

        for member in members:
            relative = _relative_path(member.name)
            target = (root / relative).resolve()
            if root not in target.parents and target != root:
                raise ValueError(f"archive path escapes destination: {member.name!r}")
            if target in targets:
                raise ValueError(f"duplicate archive path: {member.name!r}")
            targets.add(target)
            if not (member.isdir() or member.isfile()):
                raise ValueError(f"unsupported archive entry: {member.name!r}")

        for member in sorted(members, key=lambda item: len(PurePosixPath(item.name).parts)):
            target = root / _relative_path(member.name)
            if member.isdir():
                target.mkdir(mode=0o700, parents=True, exist_ok=True)
                continue

            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            payload = source.extractfile(member)
            if payload is None:
                raise ValueError(f"archive file has no payload: {member.name!r}")
            with payload, target.open("xb") as output:
                shutil.copyfileobj(payload, output)
            target.chmod(member.mode & 0o700 or 0o600)


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit("usage: safe_extract_tar.py <archive.tar.gz> <destination>")
    try:
        extract(Path(sys.argv[1]), Path(sys.argv[2]))
    except (OSError, tarfile.TarError, ValueError) as error:
        raise SystemExit(f"unsafe or invalid backup archive: {error}") from error


if __name__ == "__main__":
    main()
