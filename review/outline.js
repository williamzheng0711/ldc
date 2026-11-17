'use strict';

const OUTLINE_MAX_POINTS = 256;

function validOutline(points, tile) {
  return Array.isArray(points) && points.length >= 3 && points.length <= OUTLINE_MAX_POINTS &&
    points.every(point => Array.isArray(point) && point.length === 2 &&
      Number.isFinite(point[0]) && point[0] >= 0 && point[0] <= tile.width &&
      Number.isFinite(point[1]) && point[1] >= 0 && point[1] <= tile.height);
}

function svgElement(tag, attributes) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

function nearestOnSegment(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return start;
  const portion = ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared;
  const t = Math.max(0, Math.min(1, portion));
  return [start[0] + t * dx, start[1] + t * dy];
}

class OutlineEditor {
  constructor(box, tile, onEdit) {
    this.tile = tile;
    this.onEdit = onEdit;
    this.points = null;
    this.drag = null;
    this.svg = svgElement('svg', {
      class: 'outline', viewBox: `0 0 ${tile.width} ${tile.height}`,
      'aria-label': '脂滴輪廓編輯器',
    });
    this.edge = svgElement('polygon', {class: 'outline-edge', 'vector-effect': 'non-scaling-stroke'});
    this.shape = svgElement('polygon', {class: 'outline-shape', 'vector-effect': 'non-scaling-stroke'});
    this.handles = svgElement('g', {});
    this.svg.append(this.shape, this.edge, this.handles);
    this.svg.setAttribute('hidden', '');
    this.svg.addEventListener('pointerdown', event => this.startDrag(event));
    this.svg.addEventListener('dblclick', event => this.addOnEdge(event));
    this.svg.addEventListener('pointermove', event => this.move(event));
    for (const type of ['pointerup', 'pointercancel']) {
      this.svg.addEventListener(type, event => this.finishDrag(event));
    }
    this.svg.addEventListener('lostpointercapture', event => {
      const drag = this.drag;
      // A click can report capture loss immediately before its pointerup.
      requestAnimationFrame(() => {
        if (this.drag === drag) this.finishDrag(event);
      });
    });
    this.handles.addEventListener('keydown', event => this.editByKey(event));
    box.append(this.svg);
  }

  setPoints(points) {
    this.drag = null;
    this.svg.classList.remove('is-dragging');
    this.points = points;
    this.svg.toggleAttribute('hidden', !points);
    if (points) this.paint();
  }

  paint() {
    const geometry = this.points.map(point => point.join(',')).join(' ');
    this.shape.setAttribute('points', geometry);
    this.edge.setAttribute('points', geometry);
    while (this.handles.children.length > this.points.length) this.handles.lastChild.remove();
    const scale = this.svg.getBoundingClientRect().width / this.tile.width || 1;
    this.points.forEach(([x, y], i) => {
      let handle = this.handles.children[i];
      if (!handle) {
        handle = svgElement('g', {
          class: 'outline-vertex', tabindex: 0, 'data-index': i,
          'aria-label': `頂點 ${i + 1}。方向鍵移動，Enter 新增頂點。`,
        });
        handle.append(svgElement('circle', {fill: 'transparent'}), svgElement('circle', {
          class: 'outline-dot', 'vector-effect': 'non-scaling-stroke',
        }));
        this.handles.append(handle);
      }
      handle.setAttribute('transform', `translate(${x} ${y})`);
      handle.firstChild.setAttribute('r', 10 / scale);
      handle.lastChild.setAttribute('r', 3.2 / scale);
    });
  }

  pointerPosition(event) {
    const box = this.svg.getBoundingClientRect();
    return [(event.clientX - box.left) * this.tile.width / box.width,
      (event.clientY - box.top) * this.tile.height / box.height];
  }

  boundedPoint(x, y) {
    return [Math.max(0, Math.min(this.tile.width, Math.round(x * 100) / 100)),
      Math.max(0, Math.min(this.tile.height, Math.round(y * 100) / 100))];
  }

  startDrag(event) {
    if (!this.points || this.drag || event.button !== 0) return;
    const cursor = this.pointerPosition(event);
    const scale = this.svg.getBoundingClientRect().width / this.tile.width;
    const radius = event.pointerType === 'touch' ? 10 : 5;
    let index = -1;
    let best = radius / scale;
    this.points.forEach(([x, y], i) => {
      const distance = Math.hypot(x - cursor[0], y - cursor[1]);
      if (distance <= best) { best = distance; index = i; }
    });
    if (index < 0) return;
    this.drag = {id: event.pointerId, index, original: this.points, cursor, threshold: 3 / scale};
    this.svg.classList.add('is-dragging');
    this.svg.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  addOnEdge(event) {
    if (!this.points || this.drag || event.button !== 0 || this.points.length >= OUTLINE_MAX_POINTS) return;
    const cursor = this.pointerPosition(event);
    const distanceToCursor = ([x, y]) => Math.hypot(x - cursor[0], y - cursor[1]);
    const scale = this.svg.getBoundingClientRect().width / this.tile.width;
    if (this.points.some(point => distanceToCursor(point) <= 5 / scale)) return;

    let index = -1;
    let projected;
    let best = 10 / scale;
    this.points.forEach((start, i) => {
      const end = this.points[(i + 1) % this.points.length];
      const point = nearestOnSegment(cursor, start, end);
      const distance = distanceToCursor(point);
      if (distance > best) return;
      best = distance;
      index = i + 1;
      projected = point;
    });
    if (index < 0) return;
    const point = this.boundedPoint(...projected);
    const start = this.points[index - 1];
    const end = this.points[index % this.points.length];
    if ([start, end].some(endpoint => endpoint.every((value, axis) => value === point[axis]))) return;

    this.points = this.points.slice();
    this.points.splice(index, 0, point);
    this.paint();
    this.onEdit(this.points);
    event.preventDefault();
  }

  move(event) {
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId) return;
    const [x, y] = this.pointerPosition(event);
    const dx = x - drag.cursor[0];
    const dy = y - drag.cursor[1];
    if (this.points === drag.original && Math.hypot(dx, dy) < drag.threshold) return;
    const [originalX, originalY] = drag.original[drag.index];
    const next = dx || dy ? this.boundedPoint(originalX + dx, originalY + dy) : drag.original[drag.index];
    const current = this.points[drag.index];
    if (current[0] === next[0] && current[1] === next[1]) return;
    this.points = this.points.slice();
    this.points[drag.index] = next;
    this.paint();
  }

  finishDrag(event) {
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId) return;
    this.drag = null;
    this.svg.classList.remove('is-dragging');
    if (event.type === 'pointerup') {
      const [x, y] = this.points[drag.index];
      const [originalX, originalY] = drag.original[drag.index];
      if (x !== originalX || y !== originalY) this.onEdit(this.points);
    } else {
      this.points = drag.original;
      this.paint();
    }
  }

  editByKey(event) {
    if (this.drag) return;
    const handle = event.target.closest('[data-index]');
    if (!handle || !this.points) return;
    const index = Number(handle.dataset.index);
    const shifts = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]};
    const [x, y] = this.points[index];
    if (event.key === 'Enter' && this.points.length < OUTLINE_MAX_POINTS) {
      const [nextX, nextY] = this.points[(index + 1) % this.points.length];
      this.points = this.points.slice();
      this.points.splice(index + 1, 0, this.boundedPoint((x + nextX) / 2, (y + nextY) / 2));
      this.paint();
      this.handles.children[index + 1].focus();
    } else if (Object.hasOwn(shifts, event.key)) {
      const [dx, dy] = shifts[event.key];
      const step = event.shiftKey ? 5 : 1;
      const next = this.boundedPoint(x + step * dx, y + step * dy);
      event.preventDefault();
      if (next[0] === x && next[1] === y) return;
      this.points = this.points.slice();
      this.points[index] = next;
      this.paint();
    } else {
      return;
    }
    event.preventDefault();
    this.onEdit(this.points);
  }
}
