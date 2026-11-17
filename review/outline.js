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

  setAdding(adding) {
    this.adding = adding;
    this.svg.classList.toggle('adding', adding);
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
    const distance = ([x, y]) => Math.hypot(x - cursor[0], y - cursor[1]);
    const scale = this.svg.getBoundingClientRect().width / this.tile.width;
    const radius = event.pointerType === 'touch' ? 10 : 5;
    let index = -1;
    let best = radius / scale;
    const original = this.points;
    if (!this.adding) {
      original.forEach((point, i) => {
        const current = distance(point);
        if (current <= best) { best = current; index = i; }
      });
    }
    if (index < 0) {
      if (original.length >= OUTLINE_MAX_POINTS) return;
      let projected;
      best = 10 / scale;
      original.forEach((start, i) => {
        const point = nearestOnSegment(cursor, start, original[(i + 1) % original.length]);
        const current = distance(point);
        if (current <= best) { best = current; index = i + 1; projected = point; }
      });
      if (index < 0) return;
      const start = original[index - 1];
      const end = original[index % original.length];
      if (projected.every((value, axis) => value === start[axis]) ||
          projected.every((value, axis) => value === end[axis])) {
        projected = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
      }
      this.points = original.slice();
      this.points.splice(index, 0, this.boundedPoint(...projected));
      this.paint();
    }
    const [x, y] = this.points[index];
    this.drag = {id: event.pointerId, index, original, cursor, x, y};
    this.svg.classList.add('is-dragging');
    this.svg.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  move(event) {
    const drag = this.drag;
    if (!drag || drag.id !== event.pointerId) return;
    const [x, y] = this.pointerPosition(event);
    const next = this.boundedPoint(drag.x + x - drag.cursor[0], drag.y + y - drag.cursor[1]);
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
      const changed = this.points.length !== drag.original.length || this.points.some(
        ([x, y], i) => x !== drag.original[i][0] || y !== drag.original[i][1]);
      if (changed) this.onEdit(this.points);
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
      this.points = this.points.slice();
      this.points[index] = this.boundedPoint(x + step * dx, y + step * dy);
      this.paint();
    } else {
      return;
    }
    event.preventDefault();
    this.onEdit(this.points);
  }
}
