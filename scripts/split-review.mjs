import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const imagesPerPack = 20;
const imagePath = /^\/images\/[a-z0-9_.-]+\.png$/i;

function decrypt(packet, magic, key, binding = '') {
  const header = packet.subarray(0, 8);
  assert.equal(header.toString('ascii'), magic);
  assert.ok(packet.length >= 40);
  const decipher = createDecipheriv('aes-256-gcm', key, packet.subarray(8, 20));
  decipher.setAAD(Buffer.concat([header, Buffer.from(binding)]));
  decipher.setAuthTag(packet.subarray(-16));
  return Buffer.concat([decipher.update(packet.subarray(20, -16)), decipher.final()]);
}

function encrypt(plaintext, magic, key, binding = '') {
  const header = Buffer.from(magic, 'ascii');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.concat([header, Buffer.from(binding)]));
  return Buffer.concat([header, iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function unpack(plaintext) {
  let cursor = 4 + plaintext.readUInt32BE();
  assert.ok(cursor <= plaintext.length);
  const { files, ...metadata } = JSON.parse(plaintext.subarray(4, cursor));
  const images = new Map();
  for (const { path, length } of files) {
    assert.match(path, imagePath);
    assert.ok(!images.has(path) && Number.isSafeInteger(length) && length > 0);
    assert.ok(length <= plaintext.length - cursor);
    images.set(path, plaintext.subarray(cursor, cursor + length));
    cursor += length;
  }
  assert.equal(cursor, plaintext.length);
  return { metadata, images };
}

function pack(metadata, images) {
  const files = [...images].map(([path, bytes]) => ({ path, length: bytes.length }));
  const header = Buffer.from(JSON.stringify({ ...metadata, files }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([length, header, ...images.values()]);
}

async function writeIndividualImages(batch, images, key, output) {
  assert.ok(batch.tiles.length <= 999);
  const seenOverviews = new Set();
  const sizes = [];
  async function writeImage(path, folder, number) {
    const url = './images-v1/' + folder + '/' + String(number).padStart(3, '0') + '.bin';
    const raw = images.get(path);
    assert.ok(raw, 'Missing image in original bundle');
    const packet = encrypt(raw, 'LDCQIM01', key, url);
    assert.deepEqual(decrypt(packet, 'LDCQIM01', key, url), raw);
    const file = join(output, url);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, packet);
    return packet.length;
  }
  for (const [index, tile] of batch.tiles.entries()) {
    const bucket = String(Math.floor(index / imagesPerPack) + 1).padStart(2, '0');
    sizes.push(await writeImage(tile.raw, bucket, index + 1));
    if (!seenOverviews.has(tile.locator.raw)) {
      await writeImage(tile.locator.raw, 'overview', index + 1);
      seenOverviews.add(tile.locator.raw);
    }
  }
  console.log(`${sizes.length} cropped images and ${seenOverviews.size} separate overviews; crop bytes (min/max): ${Math.min(...sizes)} / ${Math.max(...sizes)}`);
}

const [input, keyFile, output, mode] = process.argv.slice(2);
assert.ok(input && keyFile && output && (!mode || mode === '--individual'),
  'Usage: node scripts/split-review.mjs <old-bundle> <key-file> <output-dir> [--individual]');
const access = (await readFile(keyFile, 'utf8')).trim();
assert.ok(/^[A-Za-z0-9_-]{43}$/.test(access), 'Invalid key file format');
const key = Buffer.from(access, 'base64url');
const { metadata: { batch }, images } = unpack(decrypt(await readFile(input), 'LDCREV01', key));
assert.ok(batch?.batch_id && batch.tiles?.length);
assert.equal(new Set(batch.tiles.map(tile => tile.id)).size, batch.tiles.length);
if (mode === '--individual') {
  await writeIndividualImages(batch, images, key, output);
  key.fill(0);
  process.exit(0);
}
const index = encrypt(Buffer.from(JSON.stringify(batch)), 'LDCIDX01', key);
assert.deepEqual(JSON.parse(decrypt(index, 'LDCIDX01', key)), batch);
const usedPaths = new Set();
const packets = new Map();
for (let offset = 0; offset < batch.tiles.length; offset += imagesPerPack) {
  const number = offset / imagesPerPack;
  const group = batch.tiles.slice(offset, offset + imagesPerPack);
  const assets = new Map();
  for (const tile of group) {
    for (const path of [tile.raw, tile.locator.raw]) {
      assert.ok(images.has(path), 'A question references a missing image');
      assets.set(path, images.get(path));
      usedPaths.add(path);
    }
  }
  const metadata = { batch_id: batch.batch_id, pack: number };
  const packet = encrypt(pack(metadata, assets), 'LDCIMG01', key);
  assert.deepEqual(unpack(decrypt(packet, 'LDCIMG01', key)), { metadata, images: assets });
  packets.set('review-images-' + String(number + 1).padStart(2, '0') + '.bin', packet);
}
assert.equal(usedPaths.size, images.size, 'Some images are not referenced by the index');
for (const [name, bytes] of packets) await writeFile(join(output, name), bytes);
await writeFile(join(output, 'review-index.bin'), index);
key.fill(0);
const sizes = [...packets.values()].map(packet => packet.length);
console.log(`${batch.tiles.length} questions, ${packets.size} packs, ${index.length} index bytes`);
console.log(`Pack bytes (min/max): ${Math.min(...sizes)} / ${Math.max(...sizes)}`);
