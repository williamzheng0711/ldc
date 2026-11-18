'use strict';

const el = id => document.getElementById(id);
const choices = [...el('choices').querySelectorAll('input')];
const validDecisions = new Set(choices.map(input => input.value));
const TARGET = 'target';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {fatal: true});
const indexMagic = encoder.encode('LDCIDX01');
const imageMagic = encoder.encode('LDCQIM01');
const outlineMagic = encoder.encode('LDCOUT01');
const regionMagic = encoder.encode('LDCRGN01');
const imagesPerDirectory = 20;
const ahead = 10;
const behind = 2;
const locatorAhead = 3;
const locatorConcurrency = 3;
const locatorCacheLimit = 32;
const cropConcurrency = 3;
const cropCacheLimit = 24;
const regionPath = /^\/images\/region-SD[0-9]{3}\.webp$/;
const imagePath = /^\/images\/[a-z0-9_.-]+\.png$/i;
const locatorCache = new Map();
const cropRequests = new Map();
const cropCache = new Map();
const overviewNumbers = new Map();
const locatorRequests = new Map();
const locatorFailures = new Set();
const failedTiles = new Set();
const outlineHistory = new Map();
let batch, tiles = [], records = [], reviewerName, key, storagePrefix;
let index = 0, imageRequest = 0, pendingSaves = 0, restoreWarning = false;
let estimates = null, editor = null, viewport = null, loadingEstimates = false;
let estimateRequest;
let cropWindow = {order: [], failures: new Set()};
let locatorWindow = new Map();
let locatorDialogLevel = 'overview';
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

async function readIndex(reviewKey) {
  try {
    const plaintext = await readEncryptedSidecar('./review-index.bin?v=1', indexMagic, reviewKey);
    const manifest = JSON.parse(decoder.decode(plaintext));
    if (!manifest?.batch_id || !Array.isArray(manifest.tiles) || !manifest.tiles.length ||
        !manifest.tiles.every(validTile) ||
        new Set(manifest.tiles.map(tile => tile.id)).size !== manifest.tiles.length) throw new Error();
    return manifest;
  } catch (error) {
    if (error.name === 'OperationError') throw new Error('無法解鎖題目。請確認收到的金鑰。');
    throw new Error('無法載入題目索引。請確認網路連線後再試。');
  }
}

async function readEncryptedSidecar(path, expectedHeader, reviewKey, signal) {
  const response = await fetch(path, {
    credentials: 'omit', mode: 'same-origin', signal,
  });
  if (!response.ok) throw new Error();
  return decryptPacket(new Uint8Array(await response.arrayBuffer()), expectedHeader, reviewKey);
}

function decryptPacket(bytes, expectedHeader, reviewKey, path = '') {
  const header = bytes.subarray(0, expectedHeader.length);
  if (bytes.length < 40 || !expectedHeader.every((value, i) => value === header[i])) throw new Error();
  let additionalData = header;
  if (path) {
    const binding = encoder.encode(path);
    additionalData = new Uint8Array(header.length + binding.length);
    additionalData.set(header);
    additionalData.set(binding, header.length);
  }
  return crypto.subtle.decrypt({
    name: 'AES-GCM', iv: bytes.subarray(8, 20), additionalData,
  }, reviewKey, bytes.subarray(20));
}

function checkEstimates(data, manifest) {
  if (data?.batch_id !== manifest.batch_id || !data.outlines ||
      !manifest.tiles.every(tile => Object.hasOwn(data.outlines, tile.id) &&
        validOutline(data.outlines[tile.id], tile))) return null;
  return data.outlines;
}

function validTile(tile) {
  if (!tile || typeof tile.id !== 'string' || !tile.id || !Number.isInteger(tile.width) ||
      !Number.isInteger(tile.height) || tile.width < 1 || tile.height < 1 ||
      typeof tile.raw !== 'string' || !imagePath.test(tile.raw) || !validLocator(tile.locator) ||
      tile.items?.length !== 1 || tile.items[0].id !== TARGET) return false;
  if (!tile.target_xy_px) return true;
  return Array.isArray(tile.target_xy_px) && tile.target_xy_px.length === 2 &&
    tile.target_xy_px.every((value, dim) => Number.isInteger(value) && value >= 0 &&
      value < (dim === 0 ? tile.width : tile.height));
}

function cropFolder(questionIndex) {
  return String(Math.floor(questionIndex / imagesPerDirectory) + 1).padStart(2, '0');
}

async function downloadImagePacket(path, signal, onProgress, priority, retry = false) {
  const connection = new AbortController();
  const cancel = () => connection.abort();
  let timeout;
  function resetTimeout() {
    clearTimeout(timeout);
    timeout = setTimeout(cancel, 30000);
  }
  signal.addEventListener('abort', cancel, {once: true});
  if (signal.aborted) cancel();
  try {
    resetTimeout();
    const response = await fetch(path, {
      credentials: 'omit', mode: 'same-origin', signal: connection.signal,
      cache: retry ? 'reload' : 'force-cache',
      priority,
    });
    if (!response.ok) {
      const error = new Error('Image download failed');
      error.status = response.status;
      throw error;
    }
    resetTimeout();
    if (!response.body) return new Uint8Array(await response.arrayBuffer());
    const total = Number(response.headers.get('Content-Length'));
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      resetTimeout();
      chunks.push(value);
      received += value.byteLength;
      onProgress(received, total);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
  }
}

async function readImage(folder, questionIndex, controller, kind = 'crop') {
  const isRegion = kind === 'region';
  const number = String(questionIndex + 1).padStart(3, '0');
  const path = './assets-v2/' + folder + '/' + (isRegion ? 'region-' : '') + number + '.bin';
  const isCurrent = () => kind === 'crop' && questionIndex === index;
  const priority = kind === 'crop' && questionIndex >= index && questionIndex <= index + 2 ? 'high' : 'auto';
  function showProgress(received, total) {
    if (!isCurrent() || controller.signal.aborted) return;
    const percent = total > 0 ? Math.min(100, received / total * 100) : null;
    if (percent !== null) el('image-download').value = percent;
    const progress = percent !== null
      ? Math.floor(percent / 5) * 5 + '%'
      : Math.floor(received / 16384) * 16 + ' KB';
    const status = el('image-status');
    const message = '正在下載影像：' + progress;
    if (status.textContent !== message) status.textContent = message;
  }
  let bytes;
  try {
    bytes = await downloadImagePacket(path, controller.signal, showProgress, priority);
  } catch (error) {
    const transient = error.name === 'AbortError' || error.name === 'TypeError' ||
      error.status === 408 || error.status >= 500;
    if (!transient || controller.signal.aborted || !isCurrent()) throw error;
    el('image-download').removeAttribute('value');
    el('image-status').textContent = '影像下載中斷，正在重試…';
    bytes = await downloadImagePacket(path, controller.signal, showProgress, 'high', true);
  }
  return decryptPacket(bytes, isRegion ? regionMagic : imageMagic, key, path);
}

function loadCrop(questionIndex) {
  const cached = cropCache.get(questionIndex);
  if (cached) {
    cropCache.delete(questionIndex);
    cropCache.set(questionIndex, cached);
    return Promise.resolve(cached);
  }
  const pending = cropRequests.get(questionIndex);
  if (pending) return pending.promise;
  const folder = cropFolder(questionIndex);
  const controller = new AbortController();
  const promise = readImage(folder, questionIndex, controller).then(async body => {
    if (controller.signal.aborted) throw controller.signal.reason;
    const tile = tiles[questionIndex];
    const image = new Image(tile.width, tile.height);
    image.alt = '本題的骨髓小圖，藍色短線指向要判斷的位置';
    image.draggable = false;
    const type = new Uint8Array(body, 0, 1)[0] === 137 ? 'image/png' : 'image/webp';
    const url = URL.createObjectURL(new Blob([body], {type}));
    image.src = url;
    try {
      await image.decode();
      if (controller.signal.aborted) throw controller.signal.reason;
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
    cropCache.set(questionIndex, {image, url});
    if (cropCache.size > cropCacheLimit) {
      const evicted = [...cropCache.keys()].find(cachedIndex =>
        cachedIndex !== index && !cropWindow.order.includes(cachedIndex));
      if (evicted !== undefined) {
        URL.revokeObjectURL(cropCache.get(evicted).url);
        cropCache.delete(evicted);
      }
    }
    return cropCache.get(questionIndex);
  }).finally(() => {
    if (cropRequests.get(questionIndex)?.controller === controller) cropRequests.delete(questionIndex);
  });
  cropRequests.set(questionIndex, {controller, promise});
  return promise;
}

function updateCropWindow(questionIndex) {
  const order = [];
  for (let offset = 1; offset <= ahead && questionIndex + offset < tiles.length; offset++) {
    order.push(questionIndex + offset);
  }
  for (let offset = 1; offset <= behind && questionIndex >= offset; offset++) order.push(questionIndex - offset);
  cropWindow = {order, failures: new Set()};
  for (const [queuedIndex, request] of cropRequests) {
    if (queuedIndex === questionIndex || order.includes(queuedIndex)) continue;
    cropRequests.delete(queuedIndex);
    request.controller.abort();
  }
}

function fillCropWindow() {
  if (!cropCache.has(index)) return;
  for (const upcoming of cropWindow.order) {
    if (cropRequests.size >= cropConcurrency) return;
    if (cropCache.has(upcoming) || cropRequests.has(upcoming) || cropWindow.failures.has(upcoming)) continue;
    void loadCrop(upcoming).catch(error => {
      if (error?.name !== 'AbortError' || cropWindow.order.includes(upcoming)) cropWindow.failures.add(upcoming);
    }).finally(fillCropWindow);
  }
}

function regionAsset(tile) {
  return '/images/region-' + tile.id + '.webp';
}

function locatorJob(kind, questionIndex) {
  const tile = tiles[questionIndex];
  return {
    kind, questionIndex,
    raw: kind === 'region' ? regionAsset(tile) : tile.locator.raw,
  };
}

function loadLocatorAsset({kind, questionIndex, raw}) {
  const cached = locatorCache.get(raw);
  if (cached) {
    locatorCache.delete(raw);
    locatorCache.set(raw, cached);
    return Promise.resolve();
  }
  if (locatorRequests.has(raw)) return locatorRequests.get(raw).promise;
  locatorFailures.delete(raw);
  const controller = new AbortController();
  const isRegion = kind === 'region';
  const folder = isRegion ? cropFolder(questionIndex) : 'overview';
  const number = isRegion ? questionIndex : overviewNumbers.get(raw);
  const promise = readImage(folder, number, controller, kind).then(async plaintext => {
    if (controller.signal.aborted) return;
    let body = plaintext;
    let region;
    if (isRegion) {
      const bytes = new Uint8Array(plaintext);
      const start = 4 + new DataView(plaintext).getUint32(0);
      if (start >= bytes.length) throw new Error();
      region = JSON.parse(decoder.decode(bytes.subarray(4, start)));
      if (!validLocator(region, regionPath) || region.raw !== raw ||
          !validLocatorBox(region.whole_box)) throw new Error();
      body = bytes.subarray(start);
    }
    const image = new Image();
    image.alt = '';
    const url = URL.createObjectURL(new Blob([body], {type: 'image/webp'}));
    image.src = url;
    try {
      await image.decode();
      if (controller.signal.aborted) throw controller.signal.reason;
    } catch (error) {
      URL.revokeObjectURL(url);
      throw error;
    }
    locatorCache.set(raw, {image, url, region});
    if (locatorCache.size > locatorCacheLimit) {
      const evicted = [...locatorCache.keys()].find(asset => !locatorWindow.has(asset));
      if (evicted !== undefined) {
        URL.revokeObjectURL(locatorCache.get(evicted).url);
        locatorCache.delete(evicted);
      }
    }
  }).catch(() => {
    if (!controller.signal.aborted) locatorFailures.add(raw);
  }).finally(() => {
    if (locatorRequests.get(raw)?.controller !== controller) return;
    locatorRequests.delete(raw);
    const current = tiles[index];
    if (!el('locator').hidden && (raw === current.locator.raw || raw === regionAsset(current))) showLocator();
    fillLocatorWindow();
  });
  locatorRequests.set(raw, {controller, promise});
  return promise;
}

function updateLocatorWindow(questionIndex) {
  locatorWindow = new Map();
  const nearby = [questionIndex];
  for (let offset = 1; offset <= locatorAhead && questionIndex + offset < tiles.length; offset++) {
    nearby.push(questionIndex + offset);
  }
  for (let offset = 1; offset <= behind && questionIndex >= offset; offset++) nearby.push(questionIndex - offset);
  for (const next of nearby) {
    for (const kind of ['overview', 'region']) {
      const job = locatorJob(kind, next);
      if (!locatorWindow.has(job.raw)) locatorWindow.set(job.raw, job);
    }
  }
  for (const raw of locatorFailures) {
    if (!locatorWindow.has(raw)) locatorFailures.delete(raw);
  }
  for (const [raw, request] of locatorRequests) {
    if (locatorWindow.has(raw)) continue;
    locatorRequests.delete(raw);
    request.controller.abort();
  }
}

function fillLocatorWindow() {
  if (el('locator').hidden) return;
  for (const [raw, job] of locatorWindow) {
    if (locatorRequests.size >= locatorConcurrency) return;
    if (locatorCache.has(raw) || locatorRequests.has(raw) || locatorFailures.has(raw)) continue;
    void loadLocatorAsset(job);
  }
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
  status.textContent = '正在解鎖題目索引…';
  try {
    const raw = decodeBase64(access);
    const reviewKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt', 'encrypt']);
    const manifest = await readIndex(reviewKey);
    const keyId = encodeBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)).subarray(0, 12));
    raw.fill(0);
    key = reviewKey;
    batch = manifest;
    tiles = batch.tiles;
    tiles.forEach((tile, questionIndex) => {
      if (!overviewNumbers.has(tile.locator.raw)) overviewNumbers.set(tile.locator.raw, questionIndex);
    });
    reviewerName = name;
    storagePrefix = 'ldc-review-v1:' + JSON.stringify([batch.batch_id, reviewerName, keyId]) + ':';
    records = await Promise.all(tiles.map(loadDraft));
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

function showOutline(keepGesture = false) {
  const visible = editor && records[index].decision === 'correct';
  el('outline-tools').hidden = !visible;
  const tile = tiles[index];
  const estimate = visible ? estimates?.[tile.id] : null;
  const draft = visible ? records[index].outline : null;
  const points = draft ?? estimate;
  if (editor && !(keepGesture && editor.drag)) editor.setPoints(points);
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

async function showImage() {
  const questionIndex = index;
  const tile = tiles[questionIndex];
  const request = ++imageRequest;
  updateCropWindow(questionIndex);
  updateLocatorWindow(questionIndex);
  viewport?.destroy();
  viewport = null;
  editor = null;
  el('outline-tools').hidden = true;
  el('zoom-tools').hidden = true;
  el('choices').disabled = true;
  el('note').disabled = true;
  const ready = cropCache.has(questionIndex);
  el('image-status').textContent = ready ? '' : '正在載入影像…';
  el('image-status').hidden = ready;
  const progress = el('image-download');
  progress.removeAttribute('value');
  progress.hidden = ready;
  el('caption').hidden = true;
  el('retry-image').hidden = true;
  el('locator').hidden = true;
  if (!ready) el('image-slot').replaceChildren();
  let crop;
  try {
    crop = await loadCrop(questionIndex);
  } catch {
    if (request !== imageRequest) return;
    progress.hidden = true;
    el('image-status').textContent = '無法下載本題影像，請重試。';
    el('retry-image').hidden = false;
    return;
  }
  if (request !== imageRequest) return;
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
  layer.append(crop.image, target);
  box.append(layer);
  el('image-slot').replaceChildren(box);
  el('image-status').hidden = true;
  progress.hidden = true;
  el('caption').hidden = false;
  el('zoom-tools').hidden = false;
  el('choices').disabled = false;
  el('note').disabled = false;
  editor = new OutlineEditor(layer, tile, points => {
    if (request !== imageRequest || records[index].decision !== 'correct') return;
    changeOutline(points);
  });
  viewport = new ImageViewport(box, layer, tile, renderZoom);
  fillCropWindow();
  if (!estimateRequest) loadEstimates();
  const points = showOutline();
  if (records[index].decision === 'correct') viewport.focus(points);
  renderZoom(viewport.zoom);
  showLocator();
  fillLocatorWindow();
}

function validLocatorBox(box) {
  return Array.isArray(box) && box.length === 4 &&
    box.every(edge => Number.isFinite(edge) && edge >= 0 && edge <= 1) &&
    box[0] < box[2] && box[1] < box[3];
}

function validLocator(locator, allowedPath = imagePath) {
  return locator && typeof locator.raw === 'string' && allowedPath.test(locator.raw) &&
    Number.isInteger(locator.width) && Number.isInteger(locator.height) &&
    locator.width > 0 && locator.height > 0 && validLocatorBox(locator.box);
}

function setLocatorFrame(map, locator) {
  const [left, top, right, bottom] = locator.box;
  map.style.aspectRatio = `${locator.width} / ${locator.height}`;
  map.style.setProperty('--locator-ratio', locator.width / locator.height);
  map.style.setProperty('--locator-fit', `${(locator.width / locator.height) * 73}svh`);
  map.style.setProperty('--crop-left', `${left * 100}%`);
  map.style.setProperty('--crop-top', `${top * 100}%`);
  map.style.setProperty('--crop-width', `${(right - left) * 100}%`);
  map.style.setProperty('--crop-height', `${(bottom - top) * 100}%`);
}

function currentLocators() {
  const tile = tiles[index];
  const region = locatorCache.get(regionAsset(tile))?.region;
  const overview = region ? {...tile.locator, box: region.whole_box} : tile.locator;
  return {overview, region};
}

function showLocatorThumbnail(map, locator) {
  const frame = map.querySelector('.locator-frame');
  const previous = map.querySelector('img');
  const cached = locator && locatorCache.get(locator.raw);
  const placeholder = map.parentElement.querySelector('.locator-placeholder');
  placeholder.hidden = Boolean(cached);
  if (!cached) {
    previous?.remove();
    frame.hidden = true;
    map.hidden = true;
    return;
  }
  map.hidden = false;
  setLocatorFrame(map, locator);
  if (previous !== cached.image) {
    previous?.remove();
    map.prepend(cached.image);
  }
  frame.hidden = false;
}

function showLocator() {
  const {overview, region} = currentLocators();
  el('locator').hidden = !overview;
  if (!overview) return;
  showLocatorThumbnail(el('locator-map'), overview);
  showLocatorThumbnail(el('locator-region-map'), region);
  const rawRegion = regionAsset(tiles[index]);
  el('locator-open').disabled = false;
  el('locator-region-open').disabled = false;
  el('locator-overview-placeholder').textContent = locatorFailures.has(overview.raw) ? '點按重試' : '準備整圖…';
  el('locator-region-placeholder').textContent = locatorFailures.has(rawRegion) ? '點按重試' : '準備局部…';
  const failed = locatorFailures.has(overview.raw) || locatorFailures.has(rawRegion);
  const loading = locatorRequests.has(overview.raw) || locatorRequests.has(rawRegion);
  el('locator-region-retry').hidden = !failed;
  el('locator-copy').textContent = failed ? '部分定位縮圖未載入，請重試。' :
    loading || !locatorCache.has(overview.raw) || !region ? '正在準備定位縮圖…' :
    region ? '整圖黃框指向局部，局部黃框指向本題。' : '點選縮圖放大。';
  if (el('locator-dialog').open) showLocatorDialog(locatorDialogLevel);
}

async function openLocator(level) {
  const request = imageRequest;
  const loading = loadLocatorAsset(locatorJob(level, index));
  showLocator();
  await loading;
  if (request !== imageRequest) return;
  showLocatorDialog(level);
}

function showLocatorDialog(level) {
  const locators = currentLocators();
  const isRegion = level === 'region';
  const locator = locators[level];
  const thumb = el(isRegion ? 'locator-region-map' : 'locator-map').querySelector('img');
  if (!locator || !thumb?.naturalWidth) return;
  locatorDialogLevel = level;
  const map = el('locator-large');
  const full = thumb.cloneNode();
  const caption = isRegion || !locators.region ? '黃框標出本題小圖。' : '黃框標出局部定位圖的範圍。';
  full.alt = (isRegion ? '本題周邊影像。' : '整張切片縮圖。') + caption;
  map.querySelector('img')?.remove();
  map.prepend(full);
  setLocatorFrame(map, locator);
  map.querySelector('.locator-frame').hidden = false;
  el('locator-dialog-caption').textContent = caption;
  el('locator-dialog-overview').setAttribute('aria-pressed', String(!isRegion));
  el('locator-dialog-region').setAttribute('aria-pressed', String(isRegion));
  el('locator-dialog-region').disabled = el('locator-region-open').disabled;
  const dialog = el('locator-dialog');
  if (!dialog.open) dialog.showModal();
}

function selectTile(next) {
  if (!Number.isInteger(next) || next < 0 || next >= tiles.length) return;
  index = next;
  el('tile-select').value = String(index);
  el('prev').disabled = index === 0;
  el('next').disabled = index === tiles.length - 1;
  renderAnswers();
  void showImage();
}

async function exportNotes() {
  const button = el('export');
  if (records.some(record => record.decision === 'correct' && !record.outline)) {
    if (!estimateRequest) loadEstimates();
    if (loadingEstimates) {
      button.disabled = true;
      button.textContent = '正在載入輪廓…';
      await estimateRequest;
      button.disabled = false;
      button.textContent = '下載標註 JSON';
    }
  }
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
el('locator-open').onclick = () => openLocator('overview');
el('locator-region-open').onclick = () => openLocator('region');
el('locator-dialog-overview').onclick = () => openLocator('overview');
el('locator-dialog-region').onclick = () => openLocator('region');
el('locator-region-retry').onclick = () => {
  void loadLocatorAsset(locatorJob('overview', index));
  void loadLocatorAsset(locatorJob('region', index));
  showLocator();
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
function loadEstimates() {
  if (loadingEstimates) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  loadingEstimates = true;
  estimateRequest = readEncryptedSidecar('./review-outlines.bin?v=2', outlineMagic, key, controller.signal)
    .then(plaintext => {
      estimates = checkEstimates(JSON.parse(decoder.decode(plaintext)), batch);
    }).catch(() => {
      estimates = null;
    }).finally(() => {
      clearTimeout(timeout);
      loadingEstimates = false;
      if (!editor) return;
      const points = showOutline(true);
      if (points && !records[index].outline && viewport.zoom === 1) viewport.focus(points);
    });
}

el('outline-retry').onclick = () => {
  loadEstimates();
  showOutline(true);
};
el('note').oninput = event => {
  records[index].note = event.target.value;
  saveAnswer(index);
};

el('export').onclick = exportNotes;
