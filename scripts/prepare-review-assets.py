import argparse
import base64
import json
import os
from io import BytesIO
from pathlib import Path

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from PIL import Image


def unpack(packet, magic, cipher):
    assert packet[:8] == magic
    payload = cipher.decrypt(packet[8:20], packet[20:], magic)
    cursor = 4 + int.from_bytes(payload[:4], "big")
    metadata = json.loads(payload[4:cursor])
    assets = {}
    for entry in metadata.pop("files"):
        path, length = entry["path"], entry["length"]
        assert path not in assets and 0 < length <= len(payload) - cursor
        assets[path] = payload[cursor:cursor + length]
        cursor += length
    assert cursor == len(payload)
    return metadata, assets


def webp(raw, *, lossless):
    with Image.open(BytesIO(raw)) as source:
        image = source.convert("RGB")
    output = BytesIO()
    if lossless:
        image.save(output, format="WEBP", lossless=True, method=5)
        with Image.open(output) as decoded:
            assert decoded.size == image.size and decoded.tobytes() == image.tobytes()
        if len(raw) < output.tell():
            return raw, image.size
    else:
        image.thumbnail((384, 384), Image.Resampling.LANCZOS)
        image.save(output, format="WEBP", quality=68, method=5)
    return output.getvalue(), image.size


def seal(output, relative, body, cipher, magic):
    nonce = os.urandom(12)
    aad = magic + ("./" + relative).encode()
    encrypted = cipher.encrypt(nonce, body, aad)
    assert cipher.decrypt(nonce, encrypted, aad) == body
    file = output / relative
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_bytes(magic + nonce + encrypted)


def prepare(args):
    key = base64.urlsafe_b64decode(args.key_file.read_bytes().strip() + b"=")
    assert len(key) == 32
    cipher = AESGCM(key)
    metadata, images = unpack(args.original.read_bytes(), b"LDCREV01", cipher)
    batch = metadata["batch"]
    tiles = batch["tiles"]
    assert 0 < len(tiles) <= 999 and len({tile["id"] for tile in tiles}) == len(tiles)
    regional = {}
    for start in range(0, len(tiles), 25):
        path = args.context_dir / f"review-context-{start // 25 + 1:02d}.bin"
        context, previews = unpack(path.read_bytes(), b"LDCCTX01", cipher)
        assert context["batch_id"] == batch["batch_id"]
        group = tiles[start:start + 25]
        assert set(context["regions"]) == {tile["id"] for tile in group}
        assert len(previews) == len(group)
        for tile in group:
            entry = context["regions"][tile["id"]]
            assert entry["raw"] == f'/images/region-{tile["id"]}.webp'
            regional[tile["id"]] = (entry, previews[entry["raw"]])
    shared = set()
    crop_sizes, context_sizes, overview_sizes = [], [], []
    for number, tile in enumerate(tiles, 1):
        group = f"{(number - 1) // 20 + 1:02d}"
        crop, dimensions = webp(images[tile["raw"]], lossless=True)
        assert dimensions == (tile["width"], tile["height"])
        seal(args.output, f"assets-v2/{group}/{number:03d}.bin", crop, cipher, b"LDCQIM01")
        crop_sizes.append(len(crop) + 36)
        locator_raw = tile["locator"]["raw"]
        if locator_raw not in shared:
            overview, _ = webp(images[locator_raw], lossless=False)
            seal(args.output, f"assets-v2/overview/{number:03d}.bin", overview, cipher, b"LDCQIM01")
            shared.add(locator_raw)
            overview_sizes.append(len(overview) + 36)
        region, raw = regional[tile["id"]]
        preview, (width, height) = webp(raw, lossless=False)
        header = json.dumps({**region, "width": width, "height": height}, separators=(",", ":")).encode()
        body = len(header).to_bytes(4, "big") + header + preview
        seal(args.output, f"assets-v2/{group}/region-{number:03d}.bin", body, cipher, b"LDCRGN01")
        context_sizes.append(len(body) + 36)
    for kind, sizes in (("crops", crop_sizes), ("regions", context_sizes), ("overviews", overview_sizes)):
        print(f"{kind}: {len(sizes)} files, {min(sizes)}-{max(sizes)} bytes, {sum(sizes)} total")
    print(f"Question 6: crop {crop_sizes[5]}, region {context_sizes[5]} bytes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Create encrypted, browser-ready review images.")
    for name in ("original", "context_dir", "key_file", "output"):
        parser.add_argument(name, type=Path)
    prepare(parser.parse_args())
