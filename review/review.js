'use strict';

const el = id => document.getElementById(id);
const choices = [...el('choices').querySelectorAll('input')];
const validDecisions = new Set(choices.map(input => input.value));
const TARGET = 'target';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
const magic = encoder.encode('LDCREV01');
const outlineMagic = encoder.encode('LDCOUT01');
const imagePath = /^\/images\/[a-z0-9_.-]+\.png$/i;
const images = new Map();
const failedTiles = new Set();
const outlineHistory = new Map();
let batch, tiles = [], records = [], reviewerName, key, storagePrefix;
let index = 0, imageRequest = 0, pendingSaves = 0, restoreWarning = false;
let estimates = null, editor = null, viewport = null, loadingEstimates = false;
let saveQueue = Promise.resolve();

function saveStatus(message, attention = false) {
  const label = el('save-state');
  label.textContent = message;
  label.classList.toggle('attention', attention);
}

function payloadFor() {
  return {
    schema_version: 1,
    review_kind: 'segmentation_candidate_review',
    batch_id: batch.batch_id,
    title: batch.title,
    coordinate_system: 'crop_display_top_left_px',
    tiles: tiles.map((tile, i) => {
      const {decision, note, outline} = records[i];
      const points = decision === 'correct' ? outline ?? estimates?.[tile.id] : null;
      return {
        tile_id: tile.id,
        source: tile.source,
        width_px: tile.width,
        height_px: tile.height,
        mpp: tile.mpp,
        origin_xy_px: tile.origin,
        reviewed: Boolean(decision),
        note,
        decisions: decision ? [{
          id: TARGET,
          decision,
          ...(points ? {outline_xy_px: points, outline_edited: Boolean(outline)} : {}),
        }] : [],
        missed: [],
      };
    }),
  };
}

function decodeBase64(value) {
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), char => char.charCodeAt(0));
}

function encodeBase64(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

function statusForLocalSave() {
  if (failedTiles.size) {
    saveStatus('有答案未能保存在此瀏覽器。請先下載標註 JSON。', true);
  } else if (pendingSaves) {
    saveStatus('正在儲存到此瀏覽器…');
  } else if (restoreWarning) {
    saveStatus('部分舊答案無法讀取。請檢查進度。', true);
  } else if (records.some(record => record.decision || record.note)) {
    saveStatus('已儲存在此瀏覽器');
  } else {
    saveStatus('答案會自動儲存在此瀏覽器。');
  }
}

function draftPath(tile) {
  return storagePrefix + tile.id;
}

function draftParams(tile, iv) {
  return {name: 'AES-GCM', iv, additionalData: encoder.encode(draftPath(tile))};
}

async function loadDraft(tile) {
  try {
    const saved = localStorage.getItem(draftPath(tile));
    if (saved) {
      const bytes = decodeBase64(saved);
      const plain = await crypto.subtle.decrypt(draftParams(tile, bytes.subarray(0, 12)), key, bytes.subarray(12));
      const record = JSON.parse(decoder.decode(plain));
      if (!record || !(record.decision === '' || validDecisions.has(record.decision)) ||
          typeof record.note !== 'string' || record.note.length > 1500) throw new Error();
      if (record.outline !== undefined && !validOutline(record.outline, tile)) {
        delete record.outline;
        restoreWarning = true;
      }
      return record;
    }
  } catch {
    restoreWarning = true;
  }
  return {decision: '', note: ''};
}

function saveAnswer(questionIndex) {
  const tile = tiles[questionIndex];
  const value = JSON.stringify(records[questionIndex]);
  pendingSaves++;
  statusForLocalSave();
  saveQueue = saveQueue.then(async () => {
    try {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const sealed = new Uint8Array(await crypto.subtle.encrypt(draftParams(tile, iv), key, encoder.encode(value)));
      const bytes = new Uint8Array(iv.length + sealed.length);
      bytes.set(iv);
      bytes.set(sealed, iv.length);
      localStorage.setItem(draftPath(tile), encodeBase64(bytes));
      failedTiles.delete(tile.id);
    } catch {
      failedTiles.add(tile.id);
    } finally {
      pendingSaves--;
      statusForLocalSave();
    }
  });
}

async function readBundle(reviewKey) {
  let bytes;
  try {
    const response = await fetch('./review-data.bin?v=500', {credentials: 'omit', mode: 'same-origin', cache: 'no-cache'});
    if (!response.ok) throw new Error();
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new Error('無法下載題目。請確認網路連線後再試。');
  }

  const header = bytes.subarray(0, magic.length);
  if (bytes.length < 40 || !magic.every((value, i) => value === header[i])) {
    throw new Error('題目檔格式不符，請聯絡研究團隊。');
  }
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM', iv: bytes.subarray(8, 20), additionalData: header,
    }, reviewKey, bytes.subarray(20));
  } catch {
    throw new Error('無法解鎖題目。請確認收到的金鑰。');
  }
  try {
    return parseBundle(plaintext);
  } catch {
    throw new Error('題目檔內容不完整，請聯絡研究團隊。');
  }
}

async function readEstimates(reviewKey) {
  const response = await fetch('./review-outlines.bin?v=2', {
    credentials: 'omit', mode: 'same-origin', cache: 'no-cache',
  });
  if (!response.ok) throw new Error();
  const bytes = new Uint8Array(await response.arrayBuffer());
  const header = bytes.subarray(0, outlineMagic.length);
  if (bytes.length < 40 || !outlineMagic.every((value, i) => value === header[i])) throw new Error();
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: bytes.subarray(8, 20), additionalData: header,
  }, reviewKey, bytes.subarray(20));
  return JSON.parse(decoder.decode(plaintext));
}

function checkEstimates(data, manifest) {
  if (data?.batch_id !== manifest.batch_id || !data.outlines ||
      !manifest.tiles.every(tile => Object.hasOwn(data.outlines, tile.id) &&
        validOutline(data.outlines[tile.id], tile))) return null;
  return data.outlines;
}

function validTile(tile, contents) {
  if (!tile || typeof tile.id !== 'string' || !tile.id || !Number.isInteger(tile.width) ||
      !Number.isInteger(tile.height) || tile.width < 1 || tile.height < 1 ||
      !contents.has(tile.raw) || !validLocator(tile.locator) || !contents.has(tile.locator.raw) ||
      tile.items?.length !== 1 || tile.items[0].id !== TARGET) return false;
  if (!tile.target_xy_px) return true;
  return Array.isArray(tile.target_xy_px) && tile.target_xy_px.length === 2 &&
    tile.target_xy_px.every((value, dim) => Number.isInteger(value) && value >= 0 &&
      value < (dim === 0 ? tile.width : tile.height));
}

function parseBundle(plaintext) {
  const manifestLength = new DataView(plaintext).getUint32(0);
  const bytes = new Uint8Array(plaintext);
  let cursor = 4 + manifestLength;
  if (cursor > bytes.length) throw new Error();
  const {batch: manifest, files} = JSON.parse(decoder.decode(bytes.subarray(4, cursor)));
  if (!manifest?.batch_id || !Array.isArray(manifest.tiles) || !manifest.tiles.length || !Array.isArray(files)) {
    throw new Error();
  }
  const contents = new Map();
  for (const {path, length} of files) {
    if (typeof path !== 'string' || !imagePath.test(path) || contents.has(path) ||
        !Number.isSafeInteger(length) || length <= 0 || length > bytes.length - cursor) throw new Error();
    contents.set(path, bytes.subarray(cursor, cursor + length));
    cursor += length;
  }
  if (cursor !== bytes.length || !manifest.tiles.every(tile => validTile(tile, contents)) ||
      new Set(manifest.tiles.map(tile => tile.id)).size !== manifest.tiles.length) throw new Error();
  return {manifest, contents};
}

el('unlock-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = el('unlock-button');
  const status = el('unlock-status');
  if (button.disabled) return;
  const name = el('reviewer-name').value.trim();
  const access = el('access-key').value.trim();
  if (!name) { status.textContent = '請輸入標註名稱。'; return; }
  if (!/^[A-Za-z0-9_-]{43}$/.test(access)) {
    status.textContent = '請貼上收到的完整標註金鑰。';
    return;
  }
  if (!window.crypto?.subtle) {
    status.textContent = '請在支援加密功能的瀏覽器中，透過 HTTPS 開啟此頁。';
    return;
  }
  button.disabled = true;
  status.textContent = '正在下載與解鎖題目…';
  try {
    const raw = decodeBase64(access);
    const reviewKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt', 'encrypt']);
    const [{manifest, contents}, outlineData] = await Promise.all([
      readBundle(reviewKey), readEstimates(reviewKey).catch(() => null),
    ]);
    estimates = checkEstimates(outlineData, manifest);
    const keyId = encodeBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)).subarray(0, 12));
    raw.fill(0);
    key = reviewKey;
    batch = manifest;
    tiles = batch.tiles;
    reviewerName = name;
    storagePrefix = 'ldc-review-v1:' + JSON.stringify([batch.batch_id, reviewerName, keyId]) + ':';
    records = await Promise.all(tiles.map(loadDraft));
    for (const [path, body] of contents) {
      images.set(path, body);
    }
    el('access-key').value = '';
    el('reviewer').textContent = reviewerName;
    el('account').hidden = false;
    el('unlock').hidden = true;
    el('review-panel').hidden = false;
    el('tile-select').replaceChildren(...tiles.map((_, i) => new Option('', String(i))));
    renderProgress();
    const initial = tiles.findIndex(tile => tile.id === batch.initial_tile);
    const unfinished = records.findIndex(value => !value.decision);
    selectTile(Math.max(0, unfinished >= 0 ? unfinished : initial));
    statusForLocalSave();
    el('tile-select').focus();
  } catch (error) {
    status.textContent = error.message || '無法開啟題目，請再試一次。';
  } finally {
    button.disabled = false;
  }
});

el('lock').onclick = async () => {
  await saveQueue;
  if (!failedTiles.size) location.reload();
  else saveStatus('有答案尚未儲存。請先下載標註 JSON，再關閉頁面。', true);
};

window.addEventListener('beforeunload', event => {
  if (!pendingSaves && !failedTiles.size) return;
  event.preventDefault();
  event.returnValue = '';
});
function renderAnswers() {
  const value = records[index];
  for (const input of choices) input.checked = input.value === value.decision;
  if (el('note').value !== value.note) el('note').value = value.note;
}

function renderProgress() {
  const complete = records.filter(record => record.decision).length;
  el('progress').max = tiles.length;
  el('progress').value = complete;
  el('progress-text').textContent = complete === tiles.length
    ? `已答完全部 ${tiles.length} 題`
    : `已答 ${complete} / ${tiles.length}`;
  for (const [i, option] of [...el('tile-select').options].entries()) {
    option.textContent = `第 ${i + 1} 題${records[i].decision ? ' · 已答' : ''}`;
  }
}

function imageURL(path) {
  const entry = images.get(path);
  if (typeof entry === 'string') return entry;
  const url = URL.createObjectURL(new Blob([entry], {type: 'image/png'}));
  images.set(path, url);
  return url;
}

function applyOutline(points) {
  if (points === undefined) delete records[index].outline;
  else records[index].outline = points;
  showOutline();
  saveAnswer(index);
}

function changeOutline(points) {
  let history = outlineHistory.get(index);
  if (!history) {
    history = [];
    outlineHistory.set(index, history);
  }
  history.push(records[index].outline);
  applyOutline(points);
}

function showOutline() {
  const visible = editor && records[index].decision === 'correct';
  el('outline-tools').hidden = !visible;
  const tile = tiles[index];
  const estimate = visible ? estimates?.[tile.id] : null;
  const draft = visible ? records[index].outline : null;
  const points = draft ?? estimate;
  editor?.setPoints(points);
  el('outline-undo').hidden = !points;
  el('outline-undo').disabled = !points || !outlineHistory.get(index)?.length;
  el('outline-reset').hidden = !estimate;
  el('outline-reset').disabled = !draft;
  el('outline-retry').hidden = !visible || Boolean(estimate);
  el('outline-retry').disabled = loadingEstimates;
  el('outline-help').textContent = points
    ? '雙擊邊界新增頂點，拖曳頂點調整輪廓。'
    : loadingEstimates ? '正在載入輪廓…' : '暫時無法載入估計輪廓。';
  return points;
}

function renderZoom(zoom) {
  el('zoom-value').textContent = `${Math.round(zoom * 100)}%`;
  el('zoom-out').disabled = zoom === 1;
  el('zoom-reset').disabled = zoom === 1;
  el('zoom-in').disabled = zoom === MAX_IMAGE_ZOOM;
  if (editor?.points) editor.paint();
}

function showImage() {
  const tile = tiles[index];
  const request = ++imageRequest;
  viewport?.destroy();
  viewport = null;
  editor = null;
  el('outline-tools').hidden = true;
  el('zoom-tools').hidden = true;
  el('choices').disabled = true;
  el('note').disabled = true;
  el('image-status').textContent = '正在載入影像…';
  el('image-status').hidden = false;
  el('caption').hidden = true;
  el('retry-image').hidden = true;
  const box = document.createElement('div');
  box.className = 'image-box';
  box.style.aspectRatio = `${tile.width} / ${tile.height}`;
  const layer = document.createElement('div');
  layer.className = 'image-layer';
  const target = document.createElement('span');
  target.className = 'target';
  target.setAttribute('aria-hidden', 'true');
  if (tile.target_xy_px) {
    const [x, y] = tile.target_xy_px;
    target.style.setProperty('--target-x', `${(x + .5) / tile.width * 100}%`);
    target.style.setProperty('--target-y', `${(y + .5) / tile.height * 100}%`);
  }
  for (let i = 0; i < 4; i++) target.append(document.createElement('i'));
  const image = document.createElement('img');
  image.alt = '本題的骨髓小圖，藍色短線指向要判斷的位置';
  image.width = tile.width;
  image.height = tile.height;
  image.draggable = false;
  image.addEventListener('load', () => {
    if (request !== imageRequest) return;
    el('image-slot').replaceChildren(box);
    el('image-status').hidden = true;
    el('caption').hidden = false;
    el('zoom-tools').hidden = false;
    el('choices').disabled = false;
    el('note').disabled = false;
    editor = new OutlineEditor(layer, tile, points => {
      if (request !== imageRequest || records[index].decision !== 'correct') return;
      changeOutline(points);
    });
    viewport = new ImageViewport(box, layer, tile, renderZoom);
    const points = showOutline();
    if (records[index].decision === 'correct') viewport.focus(points);
    renderZoom(viewport.zoom);
  });
  image.addEventListener('error', () => {
    if (request !== imageRequest) return;
    el('image-status').textContent = '無法載入這張影像，請重試。';
    el('retry-image').hidden = false;
  });
  layer.append(image, target);
  box.append(layer);
  el('image-slot').replaceChildren();
  image.src = imageURL(tile.raw);
}

function validLocator(locator) {
  if (!locator || typeof locator.raw !== 'string' || !/^\/images\/[a-z0-9_.-]+\.png$/i.test(locator.raw) ||
      !Number.isInteger(locator.width) || !Number.isInteger(locator.height) || locator.width < 1 || locator.height < 1 ||
      !Array.isArray(locator.box) || locator.box.length !== 4 ||
      !locator.box.every(edge => Number.isFinite(edge) && edge >= 0 && edge <= 1)) return false;
  const [left, top, right, bottom] = locator.box;
  return left < right && top < bottom;
}

function setLocatorFrame(map, locator) {
  const [left, top, right, bottom] = locator.box;
  map.style.aspectRatio = `${locator.width} / ${locator.height}`;
  map.style.setProperty('--locator-fit', `${(locator.width / locator.height) * 73}svh`);
  map.style.setProperty('--crop-left', `${left * 100}%`);
  map.style.setProperty('--crop-top', `${top * 100}%`);
  map.style.setProperty('--crop-width', `${(right - left) * 100}%`);
  map.style.setProperty('--crop-height', `${(bottom - top) * 100}%`);
}

function showLocator() {
  const locator = tiles[index].locator;
  const available = validLocator(locator);
  el('locator').hidden = !available;
  if (!available) return;
  const map = el('locator-map');
  setLocatorFrame(map, locator);
  const previous = map.querySelector('img');
  const imageUrl = imageURL(locator.raw);
  if (previous?.getAttribute('src') === imageUrl && (!previous.complete || previous.naturalWidth)) return;
  const frame = map.querySelector('.locator-frame');
  frame.hidden = true;
  el('locator-open').disabled = true;
  el('locator-copy').textContent = '正在載入整圖…';
  previous?.remove();
  const thumb = new Image(locator.width, locator.height);
  thumb.alt = '';
  thumb.addEventListener('load', () => {
    if (!map.contains(thumb)) return;
    frame.hidden = false;
    el('locator-open').disabled = false;
    el('locator-copy').textContent = '黃框標出本題小圖的位置。點選可放大。';
  });
  thumb.addEventListener('error', () => {
    if (!map.contains(thumb)) return;
    el('locator-copy').textContent = '暫時無法載入整圖。';
  });
  map.prepend(thumb);
  thumb.src = imageUrl;
}

function selectTile(next) {
  if (!Number.isInteger(next) || next < 0 || next >= tiles.length) return;
  index = next;
  el('tile-select').value = String(index);
  el('prev').disabled = index === 0;
  el('next').disabled = index === tiles.length - 1;
  renderAnswers();
  showImage();
  showLocator();
}

function exportNotes() {
  const result = { ...payloadFor(), reviewer: reviewerName };
  const json = JSON.stringify(result, null, 2) + '\n';
  const url = URL.createObjectURL(new Blob([json], {type: 'application/json'}));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'H&E-review.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

el('prev').onclick = () => selectTile(index - 1);
el('next').onclick = () => selectTile(index + 1);
el('tile-select').onchange = event => selectTile(Number(event.target.value));
el('retry-image').onclick = showImage;
el('locator-open').onclick = () => {
  const locator = tiles[index].locator;
  const thumb = el('locator-map').querySelector('img');
  if (!validLocator(locator) || !thumb?.naturalWidth) return;
  const map = el('locator-large');
  const full = thumb.cloneNode();
  full.alt = '原圖縮圖，黃框標出本題小圖的位置';
  map.querySelector('img')?.remove();
  map.prepend(full);
  setLocatorFrame(map, locator);
  map.querySelector('.locator-frame').hidden = false;
  el('locator-dialog').showModal();
};
el('choices').addEventListener('change', event => {
  const decision = event.target.value;
  const previous = records[index].decision;
  if (!validDecisions.has(decision) || decision === previous) return;
  records[index].decision = decision;
  const points = showOutline();
  if (decision === 'correct') {
    viewport?.focus(points);
    if (window.matchMedia('(max-width: 710px)').matches) {
      viewport?.box.scrollIntoView({block: 'nearest'});
    }
  } else if (previous === 'correct') {
    viewport?.reset();
  }
  renderProgress();
  saveAnswer(index);
});
el('zoom-out').onclick = () => viewport?.zoomAt(viewport.zoom / 1.3);
el('zoom-in').onclick = () => viewport?.zoomAt(viewport.zoom * 1.3);
el('zoom-reset').onclick = () => viewport?.reset();
el('outline-undo').onclick = () => {
  const history = outlineHistory.get(index);
  if (history?.length) applyOutline(history.pop());
};
el('outline-reset').onclick = () => changeOutline(undefined);
el('outline-retry').onclick = async () => {
  const requestedImage = imageRequest;
  loadingEstimates = true;
  showOutline();
  try {
    estimates = checkEstimates(await readEstimates(key), batch);
  } catch {
    estimates = null;
  } finally {
    loadingEstimates = false;
    const points = showOutline();
    if (requestedImage === imageRequest && points) viewport?.focus(points);
  }
};
el('note').oninput = event => {
  records[index].note = event.target.value;
  saveAnswer(index);
};

el('export').onclick = exportNotes;
