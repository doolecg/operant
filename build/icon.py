"""Operant 2's app icon, drawn by the voxel-icons skill:

    python <voxel-icons skill>/scripts/draw.py build/icon.py

A crew: four operator columns standing on a shared plate, the tall orange lead at the back with blue and green
operators in front (Operant 1's tile colours), and a violet task voxel arriving above the green one. Sizes up to
32 px drop the plate and the task so the columns stay readable. Writes electron-builder's build/icon.png, .ico and .icns.
"""
from voxel import BLUE, GREEN, ORANGE, PAPER, VIOLET, Box, by_depth, space, voxel


GAP = 1.35  # column spacing: a gap between operators so they read as separate people


def crew(px):
    small = px <= 32
    lift = 0 if small else 0.3
    columns = {(0, 0): (3, ORANGE), (1, 0): (2, BLUE), (0, 1): (2, GREEN), (1, 1): (1, BLUE)}
    cells = [
        voxel(x * GAP, y + lift, z * GAP, colours) for (x, z), (h, colours) in columns.items() for y in range(h)
    ]
    size = GAP + 1
    scene = [space(0, 0, 0, size, 3 + lift if small else 4.2, size)]
    if not small:
        scene.append(Box(-0.2, 0, -0.2, size + 0.4, 0.3, size + 0.4, PAPER))
    scene += by_depth(cells)
    if not small:
        scene.append(voxel(0, 3.2, GAP, VIOLET))
    return scene


ICONS = [
    {"name": "app",
     "drawing": crew,
     "edge": lambda px: 55 if px <= 32 else 90,
     "png": {"icon.png": 1024},
     "ico": "icon.ico",
     "icns": "icon.icns"},
]
