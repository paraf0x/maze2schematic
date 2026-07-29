# scripts/make_web_themes.py
"""Builds web/themes/ (the web app's built-in theme assets) from the repo's
tile sources. Replaces the old scripts/make_web_presets.py now that the web
app supports multiple named tile-set "themes" instead of a single preset
copy (GitHub Pages has no directory listing, hence the generated
index.json manifest).

Each theme's source tiles are flattened into web/themes/<id>/ (no
subdirectories) -- source layouts differ (presets/ nests tiles in
per-type subdirectories, tiles_fallout/ and tiles_vault/ are already flat)
but the web app only needs a flat file list per theme.

Rerun after changes to presets/, tiles_fallout/, or tiles_vault/.
"""
import json
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DST = ROOT / "web" / "themes"

# All built-in themes ship with the closed tile disabled by default: at low
# coverage the solid cells then stay empty (air) in the schematic. Users can
# re-enable the closed tile per theme in the tile manager.
THEMES = [
    {
        "id": "classic",
        "label": "Classic stone",
        "src": ROOT / "presets",
        "variants": "variants.json",
    },
    {
        "id": "plain",
        "label": "Plain walls",
        "src": ROOT / "tiles",
        "variants": None,
    },
    {
        "id": "catacombs",
        "label": "Paris catacombs",
        "src": ROOT / "tiles_catacombs",
        "variants": None,
    },
    {
        "id": "fallout-metro",
        "label": "Fallout metro",
        "src": ROOT / "tiles_fallout",
        "variants": None,
    },
    {
        "id": "vault-tube",
        "label": "Vault tube",
        "src": ROOT / "tiles_vault",
        "variants": None,
    },
]

DEFAULT_DISABLED = ["closed"]


def build_theme(theme: dict) -> dict:
    src: Path = theme["src"]
    theme_id = theme["id"]
    dst = DST / theme_id
    dst.mkdir(parents=True, exist_ok=True)

    files = []
    seen = set()
    for tile in sorted(src.rglob("*.litematic")):
        if tile.name in seen:
            raise SystemExit(
                f"{theme_id}: filename collision after flattening: {tile.name}"
            )
        seen.add(tile.name)
        shutil.copy2(tile, dst / tile.name)
        files.append(tile.name)

    manifest = {"id": theme_id, "label": theme["label"], "dir": theme_id, "files": files}
    # Disable every variant of the default-disabled types (disabling only the
    # base while a style variant stays enabled would be a TileError).
    disabled = [
        name[: -len(".litematic")]
        for name in files
        if any(
            name == f"{stem}.litematic" or name.startswith(f"{stem}_")
            for stem in DEFAULT_DISABLED
        )
    ]
    if disabled:
        manifest["disabled"] = disabled

    variants_name = theme["variants"]
    if variants_name:
        variants_src = src / variants_name
        if variants_src.is_file():
            shutil.copy2(variants_src, dst / variants_name)
            manifest["variants"] = variants_name

    return manifest


def main() -> None:
    if DST.exists():
        shutil.rmtree(DST)
    DST.mkdir(parents=True)

    manifests = [build_theme(theme) for theme in THEMES]
    (DST / "index.json").write_text(json.dumps({"themes": manifests}, indent=2) + "\n")

    for m in manifests:
        print(f"{m['id']}: {len(m['files'])} tiles -> {DST / m['dir']}")


if __name__ == "__main__":
    main()
