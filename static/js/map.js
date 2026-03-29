// map.js — Konva battle map

const GRID = 50; // px per cell

let stage, imageLayer, gridLayer, tokenLayer, rulerLayer;
let selectedTokenId = null;
const tokenNodes = {}; // token_id -> Konva.Group
let mapImageNode = null;
let mapHandleNode = null;
let currentMapImage = { url: null, offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
let currentCols = 20, currentRows = 15;
let mapImageLoadGen = 0; // incremented on each load to discard stale callbacks
let rulerActive = false;
let rulerStart = null; // { col, row }

function initMap(cols, rows) {
  currentCols = cols;
  currentRows = rows;
  const container = document.getElementById("map-container");

  // Clean up existing stage on reconnect so we don't double-render
  if (stage) {
    stage.destroy();
    Object.keys(tokenNodes).forEach(k => delete tokenNodes[k]);
    selectedTokenId = null;
    mapImageNode = null;
  }

  const W = container.clientWidth || 800;
  const H = container.clientHeight || 600;

  stage = new Konva.Stage({
    container: "map-container",
    width: W,
    height: H,
    draggable: true,
  });

  imageLayer = new Konva.Layer();
  gridLayer = new Konva.Layer();
  tokenLayer = new Konva.Layer();
  rulerLayer = new Konva.Layer({ listening: false });
  stage.add(imageLayer);
  stage.add(gridLayer);
  stage.add(tokenLayer);
  stage.add(rulerLayer);

  if (currentMapImage.url) {
    // setMapImage calls drawGrid internally (and skips background rect correctly)
    setMapImage(currentMapImage.url, currentMapImage.offsetX, currentMapImage.offsetY);
  } else {
    drawGrid(cols, rows);
  }

  // Track panning so a pan-end doesn't fire a deselect click
  let stagePanned = false;
  stage.on("dragmove", () => { stagePanned = true; });
  stage.on("click tap", (e) => {
    if (e.target === stage && !stagePanned) deselectToken();
    stagePanned = false;
  });

  // Zoom toward mouse on scroll
  stage.on("wheel", (e) => {
    e.evt.preventDefault();
    const oldScale = stage.scaleX();
    const pointer = stage.getPointerPosition();
    const mousePointTo = {
      x: (pointer.x - stage.x()) / oldScale,
      y: (pointer.y - stage.y()) / oldScale,
    };
    const factor = e.evt.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newScale = Math.max(0.25, Math.min(4, oldScale * factor));
    stage.scale({ x: newScale, y: newScale });
    stage.position({
      x: pointer.x - mousePointTo.x * newScale,
      y: pointer.y - mousePointTo.y * newScale,
    });
    stage.batchDraw();
  });

  // Ruler: mousedown starts, mousemove updates, mouseup clears
  stage.on("mousedown.ruler", () => {
    if (!rulerActive) return;
    rulerStart = stagePointerToCell();
  });
  stage.on("mousemove.ruler", () => {
    if (!rulerActive || !rulerStart) return;
    drawRuler(rulerStart, stagePointerToCell());
  });
  stage.on("mouseup.ruler", () => {
    if (!rulerActive) return;
    clearRuler();
  });

  // Handle resize
  window.addEventListener("resize", () => {
    stage.width(container.clientWidth);
    stage.height(container.clientHeight);
    stage.batchDraw();
  });
}

function resetMapView() {
  stage.position({ x: 0, y: 0 });
  stage.scale({ x: 1, y: 1 });
  stage.batchDraw();
}

function drawGrid(cols, rows) {
  gridLayer.destroyChildren();
  const W = cols * GRID;
  const H = rows * GRID;

  // Background — hidden when a map image is loaded
  if (!currentMapImage.url) {
    gridLayer.add(new Konva.Rect({
      x: 0, y: 0, width: W, height: H,
      fill: "#111122",
    }));
  }

  const lineStyle = { stroke: "#2a2a4a", strokeWidth: 1 };

  for (let c = 0; c <= cols; c++) {
    gridLayer.add(new Konva.Line({
      points: [c * GRID, 0, c * GRID, H],
      ...lineStyle,
    }));
  }
  for (let r = 0; r <= rows; r++) {
    gridLayer.add(new Konva.Line({
      points: [0, r * GRID, W, r * GRID],
      ...lineStyle,
    }));
  }

  gridLayer.batchDraw();
}

function addTokenToMap(token) {
  if (tokenNodes[token.id]) {
    updateTokenOnMap(token);
    return;
  }

  const isDM = document.body.dataset.role === "dm";
  const canDrag = isDM || (window.MY_UUID && token.player_id === window.MY_UUID);
  const size = token.size || 1;
  const radius = GRID * size * 0.42;

  // Center position accounts for token footprint
  const cx = (token.x + size / 2) * GRID;
  const cy = (token.y + size / 2) * GRID;

  const group = new Konva.Group({ x: cx, y: cy, draggable: canDrag, id: token.id });

  // Shadow
  group.add(new Konva.Circle({
    radius: radius + 3,
    fill: "rgba(0,0,0,0.4)",
    offsetY: 3,
  }));

  // Body group — clipped to circle, holds fill color + optional image
  const bodyGroup = new Konva.Group({
    clipFunc: (ctx) => { ctx.arc(0, 0, radius, 0, Math.PI * 2); },
  });

  bodyGroup.add(new Konva.Circle({
    radius,
    fill: token.color || "#e74c3c",
    name: "body-fill",
  }));

  if (token.image_url) {
    const img = new Image();
    img.onload = () => {
      bodyGroup.add(new Konva.Image({
        image: img,
        x: -radius, y: -radius,
        width: radius * 2, height: radius * 2,
        listening: false,
      }));
      tokenLayer.batchDraw();
    };
    img.onerror = () => {
      // Image failed — fall back to initials
      bodyGroup.add(makeInitialsText(token.name, radius));
      tokenLayer.batchDraw();
    };
    img.src = token.image_url;
  } else {
    bodyGroup.add(makeInitialsText(token.name, radius));
  }

  group.add(bodyGroup);

  // Ring — used for selection highlight, sits on top of body
  group.add(new Konva.Circle({
    radius,
    stroke: "#fff",
    strokeWidth: 2,
    name: "body",
    listening: false,
  }));

  // HP bar
  const barW = radius * 2;
  const barH = Math.max(4, size * 3);
  group.add(new Konva.Rect({
    x: -radius, y: radius + 4,
    width: barW, height: barH,
    fill: "#333", cornerRadius: 2,
    name: "hp-bg", listening: false,
  }));

  const hpPct = token.max_hp > 0 ? token.hp / token.max_hp : 1;
  group.add(new Konva.Rect({
    x: -radius, y: radius + 4,
    width: barW * hpPct, height: barH,
    fill: hpColor(hpPct), cornerRadius: 2,
    name: "hp-fill", listening: false,
  }));

  // Name label
  const labelW = Math.max(80, radius * 2);
  group.add(new Konva.Text({
    text: token.name,
    fontSize: 10, fill: "#ccc",
    stroke: "#000", strokeWidth: 2, fillAfterStrokeEnabled: true,
    align: "center",
    offsetX: labelW / 2,
    y: radius + barH + 6,
    width: labelW,
    listening: false, name: "label",
  }));

  group.on("click tap", (e) => { e.cancelBubble = true; selectToken(token.id); });

  group.on("contextmenu", (e) => {
    e.evt.preventDefault();
    e.cancelBubble = true;
    const isDM = document.body.dataset.role === "dm";
    const canEdit = isDM || (window.MY_UUID && token.player_id === window.MY_UUID);
    if (!canEdit) return;
    selectToken(token.id);
    window.openEditToken(token.id);
  });

  group.on("dragend", () => {
    const newX = Math.round(group.x() / GRID - size / 2);
    const newY = Math.round(group.y() / GRID - size / 2);
    group.x((newX + size / 2) * GRID);
    group.y((newY + size / 2) * GRID);
    tokenLayer.batchDraw();
    window.socketEmit("move_token", { id: token.id, x: newX, y: newY });
  });

  renderConditionIcons(group, token, radius);
  tokenNodes[token.id] = group;
  tokenLayer.add(group);
  tokenLayer.batchDraw();
}

function makeInitialsText(name, radius) {
  return new Konva.Text({
    text: name.slice(0, 2).toUpperCase(),
    fontSize: radius * 0.75,
    fontStyle: "bold",
    fill: "#fff",
    align: "center",
    verticalAlign: "middle",
    offsetX: radius * 0.37,
    offsetY: radius * 0.37,
    listening: false,
  });
}

function updateTokenOnMap(token) {
  const group = tokenNodes[token.id];
  if (!group) return;

  const size = token.size || 1;
  const radius = GRID * size * 0.42;

  group.x((token.x + size / 2) * GRID);
  group.y((token.y + size / 2) * GRID);

  const hpPct = token.max_hp > 0 ? token.hp / token.max_hp : 1;
  const fill = group.findOne(".hp-fill");
  if (fill) {
    fill.width(radius * 2 * hpPct);
    fill.fill(hpColor(hpPct));
  }

  const label = group.findOne(".label");
  if (label) label.text(token.name);

  // Only update fill color for non-image tokens
  const bodyFill = group.findOne(".body-fill");
  if (bodyFill) bodyFill.fill(token.color || "#e74c3c");

  renderConditionIcons(group, token, radius);
  tokenLayer.batchDraw();
}

function removeTokenFromMap(tokenId) {
  const group = tokenNodes[tokenId];
  if (group) {
    group.destroy();
    delete tokenNodes[tokenId];
    tokenLayer.batchDraw();
  }
  if (selectedTokenId === tokenId) deselectToken();
}

function selectToken(tokenId) {
  // Remove highlight from previously selected
  if (selectedTokenId && tokenNodes[selectedTokenId]) {
    const prev = tokenNodes[selectedTokenId].findOne(".body");
    if (prev) prev.strokeWidth(2);
  }

  selectedTokenId = tokenId;
  const group = tokenNodes[tokenId];
  if (group) {
    const body = group.findOne(".body");
    if (body) body.strokeWidth(4);
    tokenLayer.batchDraw();
  }

  window.onTokenSelected(tokenId);
}

function deselectToken() {
  if (selectedTokenId && tokenNodes[selectedTokenId]) {
    const body = tokenNodes[selectedTokenId].findOne(".body");
    if (body) body.strokeWidth(2);
    tokenLayer.batchDraw();
  }
  selectedTokenId = null;
  window.onTokenSelected(null);
}

function highlightCurrentTurn(tokenId) {
  // Remove all turn highlights
  tokenLayer.find(".body").forEach(n => n.stroke("#fff"));
  if (tokenId && tokenNodes[tokenId]) {
    const body = tokenNodes[tokenId].findOne(".body");
    if (body) body.stroke("#ff00ff");
  }
  tokenLayer.batchDraw();
}

function hpColor(pct) {
  if (pct > 0.6) return "#2ecc71";
  if (pct > 0.25) return "#f39c12";
  return "#e74c3c";
}

function getSelectedTokenId() { return selectedTokenId; }

function setMapImage(url, offsetX, offsetY, scaleX = 1, scaleY = 1) {
  currentMapImage = { url, offsetX, offsetY, scaleX, scaleY };
  const gen = ++mapImageLoadGen;
  // Clear any existing image/handle and redraw grid (background depends on image presence)
  imageLayer.destroyChildren();
  mapImageNode = null;
  mapHandleNode = null;
  drawGrid(currentCols, currentRows);
  if (!url) { imageLayer.batchDraw(); return; }
  const img = new Image();
  img.onload = () => {
    if (gen !== mapImageLoadGen) return; // superseded by a newer load
    mapImageNode = new Konva.Image({
      image: img, x: offsetX, y: offsetY,
      scaleX, scaleY,
      listening: false,
    });
    imageLayer.add(mapImageNode);
    addResizeHandle();
    imageLayer.batchDraw();
  };
  img.src = url;
}

function addResizeHandle() {
  if (mapHandleNode) { mapHandleNode.destroy(); mapHandleNode = null; }
  if (!mapImageNode || document.body.dataset.role !== 'dm') return;

  const HANDLE = 10;
  mapHandleNode = new Konva.Rect({
    width: HANDLE, height: HANDLE,
    fill: '#4a90d9', stroke: '#fff', strokeWidth: 1.5,
    cornerRadius: 2, draggable: true,
    name: 'map-handle',
  });
  updateHandlePosition();

  mapHandleNode.on('mouseover', () => { document.body.style.cursor = 'se-resize'; });
  mapHandleNode.on('mouseout',  () => { document.body.style.cursor = 'default'; });

  mapHandleNode.on('dragmove', (e) => {
    const img = mapImageNode.image();
    const w = img.naturalWidth, h = img.naturalHeight;
    const cx = mapHandleNode.x() + HANDLE / 2 - currentMapImage.offsetX;
    const cy = mapHandleNode.y() + HANDLE / 2 - currentMapImage.offsetY;
    let newScaleX, newScaleY;

    if (e.evt.shiftKey) {
      // Free stretch — independent axes
      newScaleX = Math.max(0.05, cx / w);
      newScaleY = Math.max(0.05, cy / h);
    } else {
      // Uniform — project handle onto the image diagonal so aspect ratio is preserved
      const diagLen2 = w * w + h * h;
      const t = Math.max(0.05 / Math.max(w, h), (cx * w + cy * h) / diagLen2);
      newScaleX = t;
      newScaleY = t;
      // Constrain handle visually to diagonal
      mapHandleNode.x(currentMapImage.offsetX + t * w - HANDLE / 2);
      mapHandleNode.y(currentMapImage.offsetY + t * h - HANDLE / 2);
    }

    currentMapImage.scaleX = newScaleX;
    currentMapImage.scaleY = newScaleY;
    mapImageNode.scaleX(newScaleX);
    mapImageNode.scaleY(newScaleY);
    imageLayer.batchDraw();
  });

  mapHandleNode.on('dragend', () => {
    // Snap handle to exact corner after drag
    updateHandlePosition();
    imageLayer.batchDraw();
    window.socketEmit('set_map_offset', {
      offset_x: currentMapImage.offsetX,
      offset_y: currentMapImage.offsetY,
      scale_x: currentMapImage.scaleX,
      scale_y: currentMapImage.scaleY,
    });
  });

  imageLayer.add(mapHandleNode);
}

function updateHandlePosition() {
  if (!mapHandleNode || !mapImageNode) return;
  const img = mapImageNode.image();
  const HANDLE = 10;
  mapHandleNode.x(currentMapImage.offsetX + img.naturalWidth  * currentMapImage.scaleX - HANDLE / 2);
  mapHandleNode.y(currentMapImage.offsetY + img.naturalHeight * currentMapImage.scaleY - HANDLE / 2);
}

function setMapOffset(offsetX, offsetY, scaleX, scaleY) {
  currentMapImage.offsetX = offsetX;
  currentMapImage.offsetY = offsetY;
  if (scaleX !== undefined) currentMapImage.scaleX = scaleX;
  if (scaleY !== undefined) currentMapImage.scaleY = scaleY;
  if (mapImageNode) {
    mapImageNode.x(offsetX);
    mapImageNode.y(offsetY);
    if (scaleX !== undefined) mapImageNode.scaleX(scaleX);
    if (scaleY !== undefined) mapImageNode.scaleY(scaleY);
    updateHandlePosition();
    imageLayer.batchDraw();
  }
}

// --- Ruler tool ---

function stagePointerToCell() {
  const pos = stage.getRelativePointerPosition();
  return { col: Math.floor(pos.x / GRID), row: Math.floor(pos.y / GRID) };
}

function clearRuler() {
  rulerLayer.destroyChildren();
  rulerLayer.batchDraw();
  rulerStart = null;
}

function drawRuler(startCell, endCell) {
  rulerLayer.destroyChildren();

  const from = { x: (startCell.col + 0.5) * GRID, y: (startCell.row + 0.5) * GRID };
  const to   = { x: (endCell.col   + 0.5) * GRID, y: (endCell.row   + 0.5) * GRID };
  const dx = endCell.col - startCell.col;
  const dy = endCell.row - startCell.row;

  rulerLayer.add(new Konva.Line({
    points: [from.x, from.y, to.x, to.y],
    stroke: "#f0a500", strokeWidth: 2, dash: [8, 4],
  }));
  rulerLayer.add(new Konva.Circle({ x: from.x, y: from.y, radius: 5, fill: "#f0a500" }));
  rulerLayer.add(new Konva.Circle({ x: to.x,   y: to.y,   radius: 5, fill: "#f0a500" }));

  if (dx !== 0 || dy !== 0) {
    const dist = Math.round(Math.sqrt(dx * dx + dy * dy) * 5);
    const label = new Konva.Text({
      x: (from.x + to.x) / 2,
      y: (from.y + to.y) / 2,
      text: `${dist} ft`,
      fontSize: 14, fontStyle: "bold",
      fill: "#f0a500", stroke: "#000", strokeWidth: 2, fillAfterStrokeEnabled: true,
    });
    label.offsetX(label.width() / 2);
    label.offsetY(label.height() / 2);
    rulerLayer.add(label);
  }

  rulerLayer.batchDraw();
}

function toggleRulerMode() {
  rulerActive = !rulerActive;
  stage.draggable(!rulerActive);
  document.getElementById("ruler-btn").classList.toggle("active", rulerActive);
  if (!rulerActive) clearRuler();
}

// --- Condition icons ---

const COND_SIZE = 16; // icon size in canvas px
const COND_GAP  = 2;  // gap between icons

const _condImgCache = {}; // name -> Promise<HTMLImageElement|null>

function loadConditionImage(name) {
  if (!_condImgCache[name]) {
    _condImgCache[name] = new Promise(resolve => {
      const img = new Image();
      img.onload  = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = `/static/conditions/${name}.svg`;
    });
  }
  return _condImgCache[name];
}

function renderConditionIcons(group, token, radius) {
  group.findOne(".cond-group")?.destroy();

  const conditions = token.conditions || [];
  if (conditions.length === 0) return;

  const condGroup = new Konva.Group({ name: "cond-group", listening: false });
  group.add(condGroup);

  const uniqueConds = [...new Set(conditions.filter(c => c !== "exhaustion"))];
  const exhCount    = conditions.filter(c => c === "exhaustion").length;

  // Y of the top of the horizontal (non-exhaustion) icon row, directly above token
  const rowY = -radius - COND_GAP - COND_SIZE;

  // Draw background + image for a single icon
  function placeIcon(imgEl, x, y) {
    condGroup.add(new Konva.Rect({
      x, y, width: COND_SIZE, height: COND_SIZE,
      fill: "rgba(0,0,0,0.55)", cornerRadius: 3,
    }));
    condGroup.add(new Konva.Image({
      image: imgEl, x, y, width: COND_SIZE, height: COND_SIZE,
    }));
    tokenLayer.batchDraw();
  }

  // Horizontal row of non-exhaustion conditions, centered
  const rowWidth = uniqueConds.length * COND_SIZE + Math.max(0, uniqueConds.length - 1) * COND_GAP;
  const rowStartX = -(rowWidth / 2);
  uniqueConds.forEach((cond, i) => {
    const x = rowStartX + i * (COND_SIZE + COND_GAP);
    loadConditionImage(cond).then(img => { if (img) placeIcon(img, x, rowY); });
  });

  // Exhaustion stack, centered, each level stacked vertically above the horizontal row
  for (let i = 0; i < exhCount; i++) {
    const y = rowY - (exhCount - i) * (COND_SIZE + COND_GAP);
    loadConditionImage("exhaustion").then(img => { if (img) placeIcon(img, -(COND_SIZE / 2), y); });
  }
}
