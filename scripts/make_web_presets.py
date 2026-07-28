# scripts/make_web_presets.py
"""Copies presets/ to web/presets/ and generates index.json (GitHub Pages
has no directory listing). Rerun after changes to presets/."""
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
    print(f"{len(files)} tiles copied to {DST}.")


if __name__ == "__main__":
    main()
