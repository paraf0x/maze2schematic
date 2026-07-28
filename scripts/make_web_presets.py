# scripts/make_web_presets.py
"""Kopiert presets/ nach web/presets/ und erzeugt index.json (GitHub Pages
hat kein Directory-Listing). Nach Aenderungen an presets/ erneut ausfuehren."""
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "presets"
DST = ROOT / "web" / "presets"


def main() -> None:
    if DST.exists():
        shutil.rmtree(DST)
    files = []
    for src in sorted(SRC.rglob("*.litematic")):
        rel = src.relative_to(SRC)
        dst = DST / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        files.append(str(rel))
    manifest = {"files": files}
    variants = SRC / "variants.json"
    if variants.is_file():
        shutil.copy2(variants, DST / "variants.json")
        manifest["variants"] = "variants.json"
    (DST / "index.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"{len(files)} Tiles nach {DST} kopiert.")


if __name__ == "__main__":
    main()
