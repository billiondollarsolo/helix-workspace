#!/usr/bin/env python3

import io
import tarfile
import tempfile
import unittest
from pathlib import Path

from safe_extract_tar import extract


class SafeExtractTarTest(unittest.TestCase):
    def test_extracts_regular_files(self) -> None:
        with tempfile.TemporaryDirectory() as work:
            root = Path(work)
            archive = root / "backup.tar.gz"
            with tarfile.open(archive, "w:gz") as target:
                payload = b'{"version":1}'
                entry = tarfile.TarInfo("backup/manifest.json")
                entry.size = len(payload)
                target.addfile(entry, io.BytesIO(payload))

            destination = root / "restore"
            extract(archive, destination)

            self.assertEqual((destination / "backup/manifest.json").read_bytes(), payload)

    def test_rejects_unsafe_entries(self) -> None:
        unsafe_entries = (
            ("../escape", tarfile.REGTYPE, ""),
            ("/absolute", tarfile.REGTYPE, ""),
            ("backup/link", tarfile.SYMTYPE, "../../escape"),
            ("backup/hardlink", tarfile.LNKTYPE, "../escape"),
            ("backup/device", tarfile.CHRTYPE, ""),
        )
        for name, kind, linkname in unsafe_entries:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as work:
                root = Path(work)
                archive = root / "unsafe.tar.gz"
                with tarfile.open(archive, "w:gz") as target:
                    entry = tarfile.TarInfo(name)
                    entry.type = kind
                    entry.linkname = linkname
                    target.addfile(entry, io.BytesIO() if kind == tarfile.REGTYPE else None)

                with self.assertRaises(ValueError):
                    extract(archive, root / "restore")


if __name__ == "__main__":
    unittest.main()
