"""Builds src-tauri/resources/research/reporters-db.json from Free Law Project's reporters-db.

The research citation guard (src-tauri/src/research/citations.rs) recognises case reporter
citations with the same reporter abbreviations eyecite uses. Only the abbreviations are vendored:
each edition with its cite types, and each variation with the edition it stands for. Dates,
names, jurisdictions and regex templates are left out.

Usage: python scripts/build-reporters-db.py [--wheel PATH] [--check]
  --wheel PATH  use an already downloaded wheel instead of `pip download` (hash still checked).
  --check       fail if the committed files differ from a fresh build (reproducibility).
"""

import argparse
import hashlib
import json
import pathlib
import subprocess
import sys
import tempfile
import zipfile

VERSION = "3.2.66"
WHEEL = f"reporters_db-{VERSION}-py3-none-any.whl"
WHEEL_SHA256 = "4627537cb6a9da321f10aaf06981c01b5312d665aa2a083cf5b26c875918aa83"
LICENSE = "BSD-2-Clause"

ROOT = pathlib.Path(__file__).resolve().parent.parent
TARGET = ROOT / "src-tauri" / "resources" / "research" / "reporters-db.json"
LICENSE_TARGET = ROOT / "src-tauri" / "resources" / "research" / "REPORTERS-DB-LICENSE"


def wheel_bytes(path):
    if path is None:
        with tempfile.TemporaryDirectory() as folder:
            subprocess.run(
                [sys.executable, "-m", "pip", "download", f"reporters-db=={VERSION}", "--no-deps", "--only-binary=:all:", "-d", folder],
                check=True,
            )
            return (pathlib.Path(folder) / WHEEL).read_bytes()
    return pathlib.Path(path).read_bytes()


def build(data):
    editions = {}
    variations = {}
    for entries in data.values():
        for reporter in entries:
            for edition in reporter["editions"]:
                editions.setdefault(edition, set()).add(reporter["cite_type"])
            for variation, edition in reporter.get("variations", {}).items():
                variations.setdefault(variation, set()).add(edition)
    # An ambiguous variation (a few early nominative reporters share one) is resolved to the
    # alphabetically first edition so the output is deterministic. A variation spelled exactly
    # like an edition is kept only as that edition.
    return {
        "source": f"reporters-db {VERSION}, Copyright (c) 2014, Free Law Project, {LICENSE}; see REPORTERS-DB-LICENSE",
        "editions": {edition: sorted(types) for edition, types in sorted(editions.items())},
        "variations": {variation: sorted(targets)[0] for variation, targets in sorted(variations.items()) if variation not in editions},
    }


def render(table):
    """Compact JSON with one entry per line, so upstream updates diff readably."""
    dump = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    parts = ["{", f'"source":{dump(table["source"])},']
    for name in ("editions", "variations"):
        parts.append(f'"{name}":{{')
        parts.append(",\n".join(f"{dump(key)}:{dump(value)}" for key, value in table[name].items()))
        parts.append("}," if name == "editions" else "}")
    parts.append("}")
    return "\n".join(parts) + "\n"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--wheel")
    parser.add_argument("--check", action="store_true")
    options = parser.parse_args()
    raw = wheel_bytes(options.wheel)
    digest = hashlib.sha256(raw).hexdigest()
    if digest != WHEEL_SHA256:
        raise SystemExit(f"Unexpected reporters-db wheel hash {digest}")
    with tempfile.TemporaryDirectory() as folder:
        wheel = pathlib.Path(folder) / WHEEL
        wheel.write_bytes(raw)
        with zipfile.ZipFile(wheel) as archive:
            metadata = archive.read(f"reporters_db-{VERSION}.dist-info/METADATA").decode("utf-8")
            if f"License-Expression: {LICENSE}" not in metadata.splitlines():
                raise SystemExit("reporters-db metadata does not declare BSD-2-Clause")
            license_text = archive.read(f"reporters_db-{VERSION}.dist-info/licenses/LICENSE").decode("utf-8")
            data = json.loads(archive.read("reporters_db/data/reporters.json").decode("utf-8"))
    output = render(build(data))
    if options.check:
        # Compared with newlines normalized: a Windows checkout may convert them.
        committed = lambda path: path.read_text(encoding="utf-8").replace("\r\n", "\n")
        if committed(TARGET) != output or committed(LICENSE_TARGET) != license_text.replace("\r\n", "\n"):
            raise SystemExit("reporters-db.json is not reproducible from reporters-db " + VERSION)
        print(f"reporters-db.json reproducible (reporters-db {VERSION})")
        return
    TARGET.write_text(output, encoding="utf-8", newline="\n")
    LICENSE_TARGET.write_text(license_text, encoding="utf-8", newline="\n")
    print(f"wrote {TARGET} ({len(output.encode('utf-8'))} bytes, reporters-db {VERSION})")


if __name__ == "__main__":
    main()
