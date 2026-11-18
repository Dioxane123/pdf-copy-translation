"""Build a reproducible extension ZIP and checksum; no credentials or test files."""
import argparse
import hashlib
import json
import shutil
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output-dir", type=Path, default=root / "dist")
args = parser.parse_args()
output = args.output_dir.resolve()
output.mkdir(parents=True, exist_ok=True)
manifest = json.loads((root / "manifest.json").read_text())
version = manifest["version"]
archive = output / f"pdf-copy-cleaner-{version}.zip"
# Keep the install directory stable even when GitHub clones the repository as
# pdf-copy-translation, or a user checks out the source under another name.
archive_root = Path("pdf-copy-cleaner")
runtime_names = [
    "manifest.json", "README.md", "docs/MODEL_PRESETS.md", "docs/THIRD_PARTY_NOTICES.md",
    "src/background/background.js", "src/background/translation-background.mjs",
    "src/background/offscreen.html", "src/background/offscreen.js",
    "src/pdf/core.mjs", "src/pdf/reader-bootstrap.js", "src/pdf/reader.css", "src/pdf/reader.js",
    "src/translation/crypto.mjs", "src/translation/model-presets.mjs", "src/translation/translation.mjs",
    "src/ui/options.html", "src/ui/options.css", "src/ui/options.js",
    "src/ui/popup.html", "src/ui/popup.css", "src/ui/popup.js",
    "src/web/web-content.js", "src/youtube/youtube-player.js", "src/youtube/youtube-captions.js",
    "src/youtube/youtube-source.js", "src/youtube/youtube-controls.js", "src/youtube/youtube.js", "src/youtube/youtube.css",
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
    assert json.loads(z.read((archive_root / "manifest.json").as_posix())) == manifest
    entry_points = [manifest["background"]["service_worker"], manifest["action"]["default_popup"],
                    manifest["options_ui"]["page"], "pdfjs/web/viewer.html", "pdfjs/LICENSE"]
    for script in manifest["content_scripts"]:
        entry_points.extend(script.get("js", []))
        entry_points.extend(script.get("css", []))
    for name in entry_points:
        z.getinfo((archive_root / name).as_posix())
digest = hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix(".zip.sha256").write_text(f"{digest}  {archive.name}\n")
shutil.copyfile(archive, output / "pdf-copy-cleaner.zip")
print(f"{archive}: {archive.stat().st_size} bytes; {len(files)} files; ZIP verified")
print(f"SHA-256: {digest}")
