"""Build a reproducible extension ZIP and checksum; no credentials or test files."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

root = Path(__file__).resolve().parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output-dir", type=Path, default=root.parent)
args = parser.parse_args()
output = args.output_dir.resolve()
output.mkdir(parents=True, exist_ok=True)
version = json.loads((root / "manifest.json").read_text())["version"]
archive = output / f"pdf-copy-cleaner-{version}.zip"
# Keep the install directory stable even when GitHub clones the repository as
# pdf-copy-translation, or a user checks out the source under another name.
archive_root = Path("pdf-copy-cleaner")
runtime_names = [
    "manifest.json", "background.js", "core.mjs", "crypto.mjs", "model-presets.mjs",
    "offscreen.html", "offscreen.js", "options.html", "options.css", "options.js",
    "popup.html", "popup.css", "popup.js", "reader-bootstrap.js", "reader.css",
    "reader.js", "translation-background.mjs", "translation.mjs",
    "README.md", "MODEL_PRESETS.md", "THIRD_PARTY_NOTICES.md",
]
files = [root / name for name in runtime_names]
for path in files:
    if not path.is_file():
        raise FileNotFoundError(path)
files.extend(p for p in (root / "pdfjs").rglob("*") if p.is_file())
with ZipFile(archive, "w", ZIP_DEFLATED, compresslevel=9) as z:
    for path in sorted(files):
        if path.is_symlink():
            raise ValueError(f"Refusing to package a symbolic link: {path}")
        info = ZipInfo((archive_root / path.relative_to(root)).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = ZIP_DEFLATED
        info.create_system = 3
        info.external_attr = 0o100644 << 16
        z.writestr(info, path.read_bytes(), compress_type=ZIP_DEFLATED, compresslevel=9)
with ZipFile(archive) as z:
    assert z.testzip() is None
    assert json.loads(z.read("pdf-copy-cleaner/manifest.json"))["version"] == version
    assert "pdf-copy-cleaner/pdfjs/LICENSE" in z.namelist()
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix(".zip.sha256").write_text(f"{digest}  {archive.name}\n")
shutil.copyfile(archive, output / "pdf-copy-cleaner.zip")
print(f"{archive}: {archive.stat().st_size} bytes; {len(files)} files; ZIP verified")
print(f"SHA-256: {digest}")
