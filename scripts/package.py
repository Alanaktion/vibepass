"""Package the two production builds with deterministic ZIP metadata."""

import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "package.json").read_text())["version"]
for browser in ("chrome", "firefox"):
    build = root / "dist" / browser
    manifest = json.loads((build / "manifest.json").read_text())
    if manifest["version"] != version:
        raise ValueError(f"Rebuild {browser} before packaging")
    archive = build.parent / f"vibepass-{version}-{browser}.zip"
    with ZipFile(archive, "w") as output:
        for path in sorted(build.rglob("*")):
            if path.is_file():
                entry = ZipInfo(path.relative_to(build).as_posix(), (1980, 1, 1, 0, 0, 0))
                entry.create_system = 3
                entry.external_attr = 0o100644 << 16
                output.writestr(entry, path.read_bytes(), ZIP_DEFLATED, compresslevel=9)
    print(archive.name)
