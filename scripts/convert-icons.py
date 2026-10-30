#!/usr/bin/env python3
"""Convert high-res source icon into Windows .ico and Linux PNG set.

Белый/почти белый фон (>=240 по всем каналам) заменяется на прозрачный.
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "icons", "raw-icon.jpeg")
ASSETS = os.path.join(ROOT, "electron-app", "assets")
ICONS = os.path.join(ASSETS, "icons")

os.makedirs(ASSETS, exist_ok=True)
os.makedirs(ICONS, exist_ok=True)

def make_transparent(img):
    img = img.convert("RGBA")
    data = img.getdata()
    new = []
    for r, g, b, a in data:
        if r >= 240 and g >= 240 and b >= 240:
            new.append((r, g, b, 0))
        else:
            new.append((r, g, b, a))
    img.putdata(new)
    return img

src = make_transparent(Image.open(SRC))

# Windows .ico (16..256)
ico_sizes = [(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)]
src.save(os.path.join(ASSETS, "icon.ico"), format="ICO", sizes=ico_sizes)

# Linux PNG set
png_sizes = [16,32,48,128,256,512]
for s in png_sizes:
    im = src.resize((s,s), Image.LANCZOS)
    im.save(os.path.join(ICONS, f"{s}x{s}.png"))

# source png for electron-builder linux
src.resize((512,512), Image.LANCZOS).save(os.path.join(ASSETS, "icon.png"))
print("done")
