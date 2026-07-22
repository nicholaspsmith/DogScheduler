#!/usr/bin/env python3
"""Generate DogScheduler app icons: white cross on green, no dependencies."""
import struct, zlib, os

GREEN = (46, 158, 68)   # #2e9e44, matches the app accent
WHITE = (255, 255, 255)

def make_icon(size: int, path: str) -> None:
    bar = round(size * 0.28)          # cross bar thickness
    arm = round(size * 0.64)          # cross arm length
    c = size / 2
    half_bar, half_arm = bar / 2, arm / 2
    rows = []
    for y in range(size):
        row = bytearray(b"\x00")      # filter byte: None
        for x in range(size):
            dx, dy = abs(x + 0.5 - c), abs(y + 0.5 - c)
            in_cross = (dx <= half_bar and dy <= half_arm) or (dy <= half_bar and dx <= half_arm)
            row += bytes(WHITE if in_cross else GREEN)
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    print(f"wrote {path} ({size}x{size})")

if __name__ == "__main__":
    os.makedirs("public/icons", exist_ok=True)
    for s in (180, 192, 512):
        make_icon(s, f"public/icons/icon-{s}.png")
