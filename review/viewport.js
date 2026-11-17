'use strict';

const clampView = (value, min, max) => Math.max(min, Math.min(max, value));
const MAX_IMAGE_ZOOM = 12;

class ImageViewport {
  constructor(box, layer, tile, onScale) {
    this.box = box;
    this.layer = layer;
    this.tile = tile;
    this.onScale = onScale;
    this.zoom = 1;
    this.x = 0;
    this.y = 0;
    this.pan = null;
    this.gesture = null;

    box.addEventListener('wheel', event => this.wheel(event), {passive: false});
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      box.addEventListener(type, event => this.pinch(event), {passive: false});
    }
    box.addEventListener('pointerdown', event => this.startPan(event));
    box.addEventListener('pointermove', event => this.movePan(event));
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      box.addEventListener(type, event => {
        if (event.pointerId !== this.pan?.pointerId) return;
        this.pan = null;
        box.classList.remove('panning');
      });
    }
    this.resizeObserver = new ResizeObserver(() => this.onScale(this.zoom));
    this.resizeObserver.observe(box);
  }

  destroy() {
    this.resizeObserver.disconnect();
  }

  setView(zoom, x, y) {
    const changed = zoom !== this.zoom;
    this.zoom = zoom;
    this.x = clampView(x, 0, 1 - 1 / zoom);
    this.y = clampView(y, 0, 1 - 1 / zoom);
    this.layer.style.width = this.layer.style.height = `${zoom * 100}%`;
    this.layer.style.left = `${-this.x * zoom * 100}%`;
    this.layer.style.top = `${-this.y * zoom * 100}%`;
    this.box.classList.toggle('is-zoomed', zoom > 1);
    if (changed) this.onScale(zoom);
  }

  reset() {
    this.setView(1, 0, 0);
  }

  focus(points) {
    const {width, height, target_xy_px: target} = this.tile;
    if (!points?.length && !target) return;
    const outline = points?.length ? points : [target];
    const xs = outline.map(point => point[0] / width);
    const ys = outline.map(point => point[1] / height);
    const left = Math.min(...xs);
    const right = Math.max(...xs);
    const top = Math.min(...ys);
    const bottom = Math.max(...ys);
    const span = Math.max(right - left, bottom - top);
    const zoom = span ? clampView(0.68 / span, 1, 8) : 2.5;
    this.setView(zoom, (left + right - 1 / zoom) / 2, (top + bottom - 1 / zoom) / 2);
  }

  position(event) {
    const box = this.box.getBoundingClientRect();
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return [0.5, 0.5];
    return [
      clampView((event.clientX - box.left) / box.width, 0, 1),
      clampView((event.clientY - box.top) / box.height, 0, 1),
    ];
  }

  zoomAt(requestedZoom, x = 0.5, y = 0.5) {
    const zoom = clampView(requestedZoom, 1, MAX_IMAGE_ZOOM);
    if (zoom === this.zoom) return;
    const shift = 1 / this.zoom - 1 / zoom;
    this.setView(zoom, this.x + x * shift, this.y + y * shift);
  }

  wheel(event) {
    if (this.gesture) {
      event.preventDefault();
      return;
    }
    const mode = event.deltaMode;
    if (!event.deltaY || (!event.ctrlKey && Math.abs(event.deltaX) > Math.abs(event.deltaY))) return;
    if (!event.ctrlKey && this.zoom === 1 && event.deltaY > 0) return;
    event.preventDefault();
    if (this.pan || this.box.querySelector('.outline.is-dragging')) return;
    const units = mode === 1 ? 16 : mode === 2 ? this.box.clientHeight : 1;
    const delta = clampView(event.deltaY * units, -300, 300);
    this.zoomAt(this.zoom * Math.exp(-delta * (event.ctrlKey ? 0.008 : 0.0025)), ...this.position(event));
  }

  pinch(event) {
    event.preventDefault();
    if (event.type === 'gesturestart') {
      this.gesture = {zoom: this.zoom, position: this.position(event)};
    } else if (event.type === 'gesturechange') {
      if (this.gesture && !this.pan && !this.box.querySelector('.outline.is-dragging')) {
        this.zoomAt(this.gesture.zoom * event.scale, ...this.gesture.position);
      }
    } else {
      this.gesture = null;
    }
  }

  startPan(event) {
    if (this.zoom === 1 || this.pan || event.defaultPrevented || event.button !== 0) return;
    if (event.target.closest('.outline-vertex, .outline-edge')) return;
    const box = this.box.getBoundingClientRect();
    this.pan = {
      pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
      x: this.x, y: this.y, width: box.width, height: box.height,
    };
    this.box.setPointerCapture(event.pointerId);
    this.box.classList.add('panning');
    event.preventDefault();
  }

  movePan(event) {
    const pan = this.pan;
    if (!pan || pan.pointerId !== event.pointerId) return;
    this.setView(this.zoom, pan.x - (event.clientX - pan.clientX) / (pan.width * this.zoom),
      pan.y - (event.clientY - pan.clientY) / (pan.height * this.zoom));
  }
}
