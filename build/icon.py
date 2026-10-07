"""Operant's app icon is the artwork from Operant 2.8.2: build/icon.png (512x512, dark rounded square with orange,
blue and green blocks). This writes the other formats electron-builder needs from it:

    python build/icon.py

build/icon.ico (16-256 px, Windows) and build/icon.icns (macOS). Needs Pillow.
"""
from pathlib import Path

from PIL import Image

HERE = Path(__file__).parent
png = Image.open(HERE / "icon.png").convert("RGBA")
png.save(HERE / "icon.ico", sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
png.save(HERE / "icon.icns", sizes=[(s, s) for s in (16, 32, 64, 128, 256, 512)])
