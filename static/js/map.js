// map.js — Konva battle map

const GRID = 50; // px per cell

let stage, imageLayer, gridLayer, tokenLayer, selectionLayer, rulerLayer, pingLayer, spellLayer;
let selectedTokenId = null;          // primary selected token (single-click or HP editor)
let selectedTokenIds = new Set();    // all currently selected tokens
const tokenNodes = {}; // token_id -> Konva.Group
const spellNodes = {}; // shape_id -> Konva shape
const spellData  = {}; // shape_id -> shape data in grid units
let mapImageNode = null;
let mapHandleNode = null;
let currentMapImage = { url: null, offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1 };
let currentCols = 20, currentRows = 15;
let mapImageLoadGen = 0; // incremented on each load to discard stale callbacks
let rulerActive = false;
let rulerStart = null; // { col, row }
let pingActive = false;
let selectionActive = false;
let selectionRect = null;  // Konva.Rect being drawn
let selectionStart = null; // { x, y } in stage coords
// Group drag state
let _groupDragAnchorId = null;
let _groupDragStarts   = {};
// Spell overlay state
let spellActive = false;
let spellDraftShape = null;
let spellDraftLabel = null;
let spellDraftStart = null;
let spellShapeType = "circle";
let spellShapeColor = "#e74c3c";
let selectedSpellId = null;
let spellHandleNode = null;
let spellResizeLabel = null;

function initMap(cols, rows) {
  currentCols = cols;
  currentRows = rows;
  const container = document.getElementById("map-container");

  // Clean up existing stage on reconnect so we don't double-render
  if (stage) {
    stage.destroy();
    Object.keys(tokenNodes).forEach(k => delete tokenNodes[k]);
    Object.keys(spellNodes).forEach(k => delete spellNodes[k]);
    Object.keys(spellData).forEach(k => delete spellData[k]);
    selectedSpellId = null;
    spellHandleNode = null;
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
  spellLayer = new Konva.Layer({ listening: false });
  tokenLayer = new Konva.Layer();
  selectionLayer = new Konva.Layer({ listening: false });
  rulerLayer     = new Konva.Layer({ listening: false });
  pingLayer      = new Konva.Layer({ listening: false });
  stage.add(imageLayer);
  stage.add(gridLayer);
  stage.add(spellLayer);
  stage.add(tokenLayer);
  stage.add(selectionLayer);
  stage.add(rulerLayer);
  stage.add(pingLayer);

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

  // Selection box: drag on empty space to box-select tokens
  stage.on("mousedown.select touchstart.select", (e) => {
    if (!selectionActive || isTokenTarget(e.target)) return;
    selectionStart = stage.getRelativePointerPosition();
    selectionRect = new Konva.Rect({
      x: selectionStart.x, y: selectionStart.y, width: 0, height: 0,
      stroke: "#4ECCA3", strokeWidth: 1.5, dash: [6, 3],
      fill: "rgba(78,204,163,0.15)",
    });
    selectionLayer.add(selectionRect);
  });
  stage.on("mousemove.select touchmove.select", () => {
    if (!selectionActive || !selectionRect) return;
    const pos = stage.getRelativePointerPosition();
    selectionRect.x(Math.min(pos.x, selectionStart.x));
    selectionRect.y(Math.min(pos.y, selectionStart.y));
    selectionRect.width(Math.abs(pos.x  - selectionStart.x));
    selectionRect.height(Math.abs(pos.y - selectionStart.y));
    selectionLayer.batchDraw();
  });
  stage.on("mouseup.select touchend.select", () => {
    if (!selectionActive || !selectionRect) return;
    const rx = selectionRect.x(), ry = selectionRect.y();
    const rw = selectionRect.width(), rh = selectionRect.height();
    selectionLayer.destroyChildren();
    selectionRect = null;
    selectionStart = null;
    selectionLayer.batchDraw();
    if (rw < 5 && rh < 5) return; // tiny drag = intentional click, skip
    const isDM = document.body.dataset.role === "dm";
    const found = [];
    for (const [tid, grp] of Object.entries(tokenNodes)) {
      const cx = grp.x(), cy = grp.y();
      if (cx >= rx && cx <= rx + rw && cy >= ry && cy <= ry + rh) {
        const tok = window.getToken(tid);
        if (isDM || (window.MY_UUID && tok?.player_id === window.MY_UUID)) found.push(tid);
      }
    }
    if (found.length > 0) selectMultiple(found);
  });

  // Ping: click or tap emits a ping at the cursor cell
  stage.on("click.ping tap.ping", () => {
    if (!pingActive) return;
    const cell = stagePointerToCell();
    const color = document.getElementById("ping-color-input")?.value || "#4ECCA3";
    window.socketEmit("ping", { x: cell.col, y: cell.row, color });
  });

  // Ruler: mouse + touch — start, update, clear
  stage.on("mousedown.ruler touchstart.ruler", () => {
    if (!rulerActive) return;
    rulerStart = stagePointerToCell();
  });
  stage.on("mousemove.ruler touchmove.ruler", () => {
    if (!rulerActive || !rulerStart) return;
    drawRuler(rulerStart, stagePointerToCell());
  });
  stage.on("mouseup.ruler touchend.ruler", () => {
    if (!rulerActive) return;
    clearRuler();
  });

  // Spell overlay: drag to draw AoE shapes, click to select/move/resize
  stage.on("mousedown.spell touchstart.spell", (e) => {
    if (!spellActive) return;
    if (e.target === spellHandleNode) return; // let handle's own drag handle it
    const targetId = getSpellTargetId(e.target);
    if (targetId) {
      // Select shape; if already selected, allow drag to proceed (do nothing)
      if (selectedSpellId !== targetId) selectSpellShape(targetId);
      return;
    }
    // Click on empty space: deselect and start drawing
    deselectSpellShape();
    spellDraftStart = stage.getRelativePointerPosition();
  });
  stage.on("mousemove.spell touchmove.spell", (e) => {
    if (!spellActive || !spellDraftStart) return;
    const pos = stage.getRelativePointerPosition();
    const lockSquare = spellShapeType === "square" && e.evt?.shiftKey;
    spellDraftShape?.destroy();
    spellDraftLabel?.destroy();
    spellDraftShape = buildSpellDraft(spellDraftStart, pos, lockSquare);
    spellDraftLabel = buildDraftLabel(spellDraftStart, pos, lockSquare);
    if (spellDraftShape) spellLayer.add(spellDraftShape);
    if (spellDraftLabel) spellLayer.add(spellDraftLabel);
    spellLayer.batchDraw();
  });
  stage.on("mouseup.spell touchend.spell", (e) => {
    if (!spellActive || !spellDraftStart) return;
    const pos = stage.getRelativePointerPosition();
    const lockSquare = spellShapeType === "square" && e.evt?.shiftKey;
    spellDraftShape?.destroy();
    spellDraftShape = null;
    spellDraftLabel?.destroy();
    spellDraftLabel = null;
    const shapeData = buildSpellShapeData(spellDraftStart, pos, lockSquare);
    if (shapeData) window.socketEmit("add_spell_shape", shapeData);
    spellDraftStart = null;
    spellLayer.batchDraw();
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

  // HP bar — hidden from players for NPC tokens unless show_hp is true
  const showHpBar = isDM || token.show_hp !== false;
  const barW = radius * 2;
  const barH = Math.max(4, size * 3);
  group.add(new Konva.Rect({
    x: -radius, y: radius + 4,
    width: barW, height: barH,
    fill: "#333", cornerRadius: 2,
    name: "hp-bg", listening: false,
    visible: showHpBar,
  }));

  const hpPct = token.max_hp > 0 ? token.hp / token.max_hp : 1;
  group.add(new Konva.Rect({
    x: -radius, y: radius + 4,
    width: barW * hpPct, height: barH,
    fill: hpColor(hpPct), cornerRadius: 2,
    name: "hp-fill", listening: false,
    visible: showHpBar,
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

  // Long-press to edit on mobile (500ms hold without moving)
  let lpTimer = null;
  let lpStartX = 0, lpStartY = 0;
  group.on("touchstart", (e) => {
    const isDMTouch = document.body.dataset.role === "dm";
    const canEdit = isDMTouch || (window.MY_UUID && token.player_id === window.MY_UUID);
    if (!canEdit) return;
    const touch = e.evt.touches[0];
    lpStartX = touch.clientX;
    lpStartY = touch.clientY;
    lpTimer = setTimeout(() => {
      lpTimer = null;
      selectToken(token.id);
      window.openEditToken(token.id);
    }, 500);
  });
  group.on("touchmove", (e) => {
    if (!lpTimer) return;
    const touch = e.evt.touches[0];
    const dx = touch.clientX - lpStartX;
    const dy = touch.clientY - lpStartY;
    if (dx * dx + dy * dy > 100) { clearTimeout(lpTimer); lpTimer = null; }
  });
  group.on("touchend touchcancel", () => {
    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
  });

  group.on("dragstart", () => {
    if (selectedTokenIds.has(token.id) && selectedTokenIds.size > 1) {
      _groupDragAnchorId = token.id;
      _groupDragStarts   = {};
      selectedTokenIds.forEach(tid => {
        if (tokenNodes[tid]) _groupDragStarts[tid] = { x: tokenNodes[tid].x(), y: tokenNodes[tid].y() };
      });
    }
  });

  group.on("dragmove", () => {
    if (_groupDragAnchorId !== token.id || selectedTokenIds.size <= 1) return;
    const dx = group.x() - _groupDragStarts[token.id].x;
    const dy = group.y() - _groupDragStarts[token.id].y;
    selectedTokenIds.forEach(tid => {
      if (tid !== token.id && tokenNodes[tid] && _groupDragStarts[tid]) {
        tokenNodes[tid].x(_groupDragStarts[tid].x + dx);
        tokenNodes[tid].y(_groupDragStarts[tid].y + dy);
      }
    });
    tokenLayer.batchDraw();
  });

  group.on("dragend", () => {
    if (_groupDragAnchorId === token.id && selectedTokenIds.size > 1) {
      // Snap anchor, compute grid delta, apply to all selected
      const anchorNewX = Math.round(group.x() / GRID - size / 2);
      const anchorNewY = Math.round(group.y() / GRID - size / 2);
      const anchorTok  = window.getToken(token.id);
      const dx = anchorNewX - (anchorTok?.x ?? 0);
      const dy = anchorNewY - (anchorTok?.y ?? 0);
      selectedTokenIds.forEach(tid => {
        const grp = tokenNodes[tid];
        const tok  = window.getToken(tid);
        if (!grp || !tok) return;
        const sz = tok.size || 1;
        const nx = tok.x + dx, ny = tok.y + dy;
        grp.x((nx + sz / 2) * GRID);
        grp.y((ny + sz / 2) * GRID);
        window.socketEmit("move_token", { id: tid, x: nx, y: ny });
      });
      tokenLayer.batchDraw();
      _groupDragAnchorId = null;
    } else {
      _groupDragAnchorId = null;
      const newX = Math.round(group.x() / GRID - size / 2);
      const newY = Math.round(group.y() / GRID - size / 2);
      group.x((newX + size / 2) * GRID);
      group.y((newY + size / 2) * GRID);
      tokenLayer.batchDraw();
      window.socketEmit("move_token", { id: token.id, x: newX, y: newY });
    }
  });

  if (token.hidden) group.opacity(0.4);

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

  const isDM = document.body.dataset.role === "dm";
  const showHpBar = isDM || token.show_hp !== false;
  const hpPct = token.max_hp > 0 ? token.hp / token.max_hp : 1;
  const hpBg = group.findOne(".hp-bg");
  if (hpBg) hpBg.visible(showHpBar);
  const fill = group.findOne(".hp-fill");
  if (fill) {
    fill.width(radius * 2 * hpPct);
    fill.fill(hpColor(hpPct));
    fill.visible(showHpBar);
  }

  const label = group.findOne(".label");
  if (label) label.text(token.name);

  // Only update fill color for non-image tokens
  const bodyFill = group.findOne(".body-fill");
  if (bodyFill) bodyFill.fill(token.color || "#e74c3c");

  group.opacity(token.hidden ? 0.4 : 1);

  renderConditionIcons(group, token, radius);
  tokenLayer.batchDraw();
}

function clearAllHighlights() {
  tokenLayer.find(".body").forEach(n => n.strokeWidth(2));
}

function removeTokenFromMap(tokenId) {
  const group = tokenNodes[tokenId];
  if (group) {
    group.destroy();
    delete tokenNodes[tokenId];
    tokenLayer.batchDraw();
  }
  if (selectedTokenIds.has(tokenId)) {
    selectedTokenIds.delete(tokenId);
    if (selectedTokenId === tokenId) {
      selectedTokenId = null;
      window.onTokenSelected(null);
    }
  }
}

function selectToken(tokenId) {
  clearAllHighlights();
  selectedTokenIds = new Set([tokenId]);
  selectedTokenId  = tokenId;
  const group = tokenNodes[tokenId];
  if (group) {
    group.findOne(".body")?.strokeWidth(4);
    tokenLayer.batchDraw();
  }
  window.onTokenSelected(tokenId);
}

function selectMultiple(ids) {
  clearAllHighlights();
  selectedTokenIds = new Set(ids);
  selectedTokenId  = null; // no HP editor for multi-select
  ids.forEach(id => tokenNodes[id]?.findOne(".body")?.strokeWidth(4));
  tokenLayer.batchDraw();
  window.onMultipleSelected(ids.length);
}

function deselectToken() {
  clearAllHighlights();
  selectedTokenIds = new Set();
  selectedTokenId  = null;
  tokenLayer.batchDraw();
  window.onTokenSelected(null);
}

function isTokenTarget(target) {
  let node = target;
  while (node && node !== stage) {
    if (tokenNodes[node.id?.()]) return true;
    node = node.parent;
  }
  return false;
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

function getSelectedTokenId()  { return selectedTokenId; }
function getSelectedTokenIds() { return [...selectedTokenIds]; }
window.getSelectedTokenIds = getSelectedTokenIds;

function getViewportCenterCell() {
  const container = document.getElementById("map-container");
  const scale = stage.scaleX();
  const pos   = stage.position();
  const worldX = (container.clientWidth  / 2 - pos.x) / scale;
  const worldY = (container.clientHeight / 2 - pos.y) / scale;
  return {
    col: Math.max(0, Math.floor(worldX / GRID)),
    row: Math.max(0, Math.floor(worldY / GRID)),
  };
}
window.getViewportCenterCell = getViewportCenterCell;

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

function setToolActive(active) {
  tokenLayer.listening(!active);
  tokenLayer.batchDraw();
}

function toggleSelectionMode() {
  selectionActive = !selectionActive;
  stage.draggable(!selectionActive && !rulerActive && !spellActive);
  document.getElementById("select-btn").classList.toggle("active", selectionActive);
  if (!selectionActive) {
    selectionLayer.destroyChildren();
    selectionLayer.batchDraw();
    selectionRect = null;
  }
}

function toggleRulerMode() {
  rulerActive = !rulerActive;
  stage.draggable(!rulerActive && !selectionActive && !spellActive);
  setToolActive(rulerActive || pingActive || spellActive);
  document.getElementById("ruler-btn").classList.toggle("active", rulerActive);
  if (!rulerActive) clearRuler();
}

function showPing(col, row, color = "#4ECCA3") {
  const x = (col + 0.5) * GRID;
  const y = (row + 0.5) * GRID;

  function ripple(delay) {
    const circle = new Konva.Circle({
      x, y, radius: 6,
      stroke: color, strokeWidth: 2.5, opacity: 1,
    });
    pingLayer.add(circle);
    pingLayer.batchDraw();

    setTimeout(() => {
      new Konva.Tween({
        node: circle,
        duration: 1.2,
        radius: GRID * 1.2,
        opacity: 0,
        easing: Konva.Easings.EaseOut,
        onFinish: () => { circle.destroy(); pingLayer.batchDraw(); },
      }).play();
    }, delay);
  }

  ripple(0);
  ripple(350);
}

function togglePingMode() {
  pingActive = !pingActive;
  setToolActive(rulerActive || pingActive || spellActive);
  document.getElementById("ping-btn").classList.toggle("active", pingActive);
  document.getElementById("ping-color-input")?.classList.toggle("hidden", !pingActive);
}

// --- Spell overlay tool ---

function hexToRgba(hex, a) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// Returns flat [x,y, ...] array of 3 points for a 60° cone (grid units)
function conePoints(ox, oy, tx, ty) {
  const dx = tx - ox, dy = ty - oy;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.01) return [ox, oy, ox, oy, ox, oy];
  const halfBase = len * Math.tan(Math.PI / 6); // tan(30°)
  const ux = dx / len, uy = dy / len;
  return [ox, oy, tx - uy * halfBase, ty + ux * halfBase, tx + uy * halfBase, ty - ux * halfBase];
}

// Returns flat [x,y, ...] array of 4 points for a rectangle along a line (grid units)
function linePoints(x1, y1, x2, y2, halfW) {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.01) return [x1, y1, x1, y1, x1, y1, x1, y1];
  const nx = -dy / len * halfW, ny = dx / len * halfW;
  return [x1 + nx, y1 + ny, x2 + nx, y2 + ny, x2 - nx, y2 - ny, x1 - nx, y1 - ny];
}

function spellShapeProps(sx, sy, ex, ey, lockSquare = false) {
  switch (spellShapeType) {
    case "circle": return { cx: sx, cy: sy, radius: Math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2) };
    case "square": {
      if (lockSquare) {
        const side = Math.min(Math.abs(ex - sx), Math.abs(ey - sy));
        return { x: ex >= sx ? sx : sx - side, y: ey >= sy ? sy : sy - side, w: side, h: side };
      }
      return { x: Math.min(sx, ex), y: Math.min(sy, ey), w: Math.abs(ex - sx), h: Math.abs(ey - sy) };
    }
    case "cone":   return { ox: sx, oy: sy, tx: ex, ty: ey };
    case "line":   return { x1: sx, y1: sy, x2: ex, y2: ey };
    default: return {};
  }
}

function shapeLabel(data) {
  switch (data.type) {
    case "circle": return `r = ${Math.round(data.radius * 5)} ft`;
    case "square": return `${Math.round(data.w * 5)} × ${Math.round(data.h * 5)} ft`;
    case "cone": {
      const dx = data.tx - data.ox, dy = data.ty - data.oy;
      return `${Math.round(Math.sqrt(dx * dx + dy * dy) * 5)} ft`;
    }
    case "line": {
      const dx = data.x2 - data.x1, dy = data.y2 - data.y1;
      return `${Math.round(Math.sqrt(dx * dx + dy * dy) * 5)} ft`;
    }
    default: return "";
  }
}

function makeSpellKonvaShape(type, color, props, isDraft) {
  const style = {
    fill: hexToRgba(color, 0.25),
    stroke: color, strokeWidth: 2,
    dash: isDraft ? [8, 4] : [],
    listening: true, draggable: false,
  };
  switch (type) {
    case "circle":
      return new Konva.Circle({ id: props.id, x: props.cx * GRID, y: props.cy * GRID, radius: props.radius * GRID, ...style });
    case "square":
      return new Konva.Rect({ id: props.id, x: props.x * GRID, y: props.y * GRID, width: props.w * GRID, height: props.h * GRID, ...style });
    case "cone": {
      const pts = conePoints(props.ox, props.oy, props.tx, props.ty).map(v => v * GRID);
      return new Konva.Line({ id: props.id, points: pts, closed: true, ...style });
    }
    case "line": {
      const pts = linePoints(props.x1, props.y1, props.x2, props.y2, 0.5).map(v => v * GRID);
      return new Konva.Line({ id: props.id, points: pts, closed: true, ...style });
    }
    default: return null;
  }
}

function buildSpellDraft(startPx, endPx, lockSquare = false) {
  const sx = startPx.x / GRID, sy = startPx.y / GRID;
  const ex = endPx.x / GRID,   ey = endPx.y / GRID;
  if (Math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2) < 0.1) return null;
  return makeSpellKonvaShape(spellShapeType, spellShapeColor, { id: "__draft__", ...spellShapeProps(sx, sy, ex, ey, lockSquare) }, true);
}

function buildDraftLabel(startPx, endPx, lockSquare = false) {
  const sx = startPx.x / GRID, sy = startPx.y / GRID;
  const ex = endPx.x / GRID,   ey = endPx.y / GRID;
  if (Math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2) < 0.1) return null;
  const props = spellShapeProps(sx, sy, ex, ey, lockSquare);
  const text = shapeLabel({ type: spellShapeType, ...props });
  if (!text) return null;
  return new Konva.Text({
    x: endPx.x + 8, y: endPx.y - 22,
    text, fontSize: 13, fontStyle: "bold",
    fill: spellShapeColor, stroke: "#000", strokeWidth: 2, fillAfterStrokeEnabled: true,
    listening: false,
  });
}

function buildSpellShapeData(startPx, endPx, lockSquare = false) {
  const sx = startPx.x / GRID, sy = startPx.y / GRID;
  const ex = endPx.x / GRID,   ey = endPx.y / GRID;
  if (Math.sqrt((ex - sx) ** 2 + (ey - sy) ** 2) < 0.2) return null;
  return { id: crypto.randomUUID(), type: spellShapeType, color: spellShapeColor, ...spellShapeProps(sx, sy, ex, ey, lockSquare) };
}

function getSpellTargetId(target) {
  let node = target;
  while (node && node !== stage) {
    const id = node.id?.();
    if (id && spellNodes[id] !== undefined) return id;
    node = node.parent;
  }
  return null;
}

// World-pixel position of the resize handle for a given shape (uses stored data, not node offset)
function getResizeHandlePos(data) {
  switch (data.type) {
    case "circle": return { x: (data.cx + data.radius) * GRID, y: data.cy * GRID };
    case "square": return { x: (data.x + data.w) * GRID,       y: (data.y + data.h) * GRID };
    case "cone":   return { x: data.tx * GRID,                  y: data.ty * GRID };
    case "line":   return { x: data.x2 * GRID,                  y: data.y2 * GRID };
    default:       return { x: 0, y: 0 };
  }
}

// Adjust handle position to account for node's current drag offset
function getHandlePosForNode(data, node) {
  const base = getResizeHandlePos(data);
  if (data.type === "circle" || data.type === "square") {
    // For these, node.x/y IS the absolute position; compute offset from original
    const origX = data.type === "circle" ? data.cx * GRID : data.x * GRID;
    const origY = data.type === "circle" ? data.cy * GRID : data.y * GRID;
    return { x: base.x + (node.x() - origX), y: base.y + (node.y() - origY) };
  }
  // cone/line: node.x/y is a drag offset from 0
  return { x: base.x + node.x(), y: base.y + node.y() };
}

// Update a placed Konva node in-place from shape data (also resets any drag offset)
function updateSpellKonvaNode(node, data) {
  switch (data.type) {
    case "circle":
      node.x(data.cx * GRID); node.y(data.cy * GRID); node.radius(data.radius * GRID);
      break;
    case "square":
      node.x(data.x * GRID); node.y(data.y * GRID);
      node.width(data.w * GRID); node.height(data.h * GRID);
      break;
    case "cone":
      node.x(0); node.y(0);
      node.points(conePoints(data.ox, data.oy, data.tx, data.ty).map(v => v * GRID));
      break;
    case "line":
      node.x(0); node.y(0);
      node.points(linePoints(data.x1, data.y1, data.x2, data.y2, 0.5).map(v => v * GRID));
      break;
  }
}

function shiftShapeData(data, dx, dy) {
  switch (data.type) {
    case "circle": return { ...data, cx: data.cx + dx, cy: data.cy + dy };
    case "square": return { ...data, x: data.x + dx, y: data.y + dy };
    case "cone":   return { ...data, ox: data.ox+dx, oy: data.oy+dy, tx: data.tx+dx, ty: data.ty+dy };
    case "line":   return { ...data, x1: data.x1+dx, y1: data.y1+dy, x2: data.x2+dx, y2: data.y2+dy };
    default: return data;
  }
}

function applyHandlePos(data, hx, hy) {
  const hxG = hx / GRID, hyG = hy / GRID;
  switch (data.type) {
    case "circle": {
      const r = Math.sqrt((hxG - data.cx) ** 2 + (hyG - data.cy) ** 2);
      return r > 0.1 ? { ...data, radius: r } : null;
    }
    case "square": {
      const w = hxG - data.x, h = hyG - data.y;
      return (w > 0.1 && h > 0.1) ? { ...data, w, h } : null;
    }
    case "cone":  return { ...data, tx: hxG, ty: hyG };
    case "line":  return { ...data, x2: hxG, y2: hyG };
    default: return null;
  }
}

function selectSpellShape(id) {
  if (selectedSpellId === id) return;
  deselectSpellShape();
  const node = spellNodes[id];
  if (!node) return;
  selectedSpellId = id;

  node.stroke("#fff");
  node.strokeWidth(3);
  node.draggable(true);

  node.on("dragmove.spellmove", () => {
    if (!spellHandleNode) return;
    const hp = getHandlePosForNode(spellData[id], node);
    spellHandleNode.x(hp.x);
    spellHandleNode.y(hp.y);
    spellLayer.batchDraw();
  });
  node.on("dragend.spellmove", () => onSpellShapeMoved(id));

  showSpellHandle(id);
  document.getElementById("spell-delete-btn")?.style.setProperty("display", "block");
  spellLayer.batchDraw();
}

function deselectSpellShape() {
  if (!selectedSpellId) return;
  const node = spellNodes[selectedSpellId];
  if (node) {
    node.stroke(spellData[selectedSpellId]?.color ?? spellShapeColor);
    node.strokeWidth(2);
    node.draggable(false);
    node.off("dragmove.spellmove");
    node.off("dragend.spellmove");
  }
  spellHandleNode?.destroy();
  spellHandleNode = null;
  spellResizeLabel?.destroy();
  spellResizeLabel = null;
  selectedSpellId = null;
  document.getElementById("spell-delete-btn")?.style.setProperty("display", "none");
  spellLayer.batchDraw();
}

function showSpellHandle(id) {
  spellHandleNode?.destroy();
  const data = spellData[id];
  if (!data) return;
  const hp = getResizeHandlePos(data);
  spellHandleNode = new Konva.Circle({
    x: hp.x, y: hp.y,
    radius: 7, fill: "#fff", stroke: "#444", strokeWidth: 1.5,
    draggable: true,
  });
  spellHandleNode.on("dragmove", () => {
    const newData = applyHandlePos(spellData[id], spellHandleNode.x(), spellHandleNode.y());
    if (newData) {
      updateSpellKonvaNode(spellNodes[id], newData);
      spellResizeLabel?.destroy();
      const text = shapeLabel(newData);
      if (text) {
        spellResizeLabel = new Konva.Text({
          x: spellHandleNode.x() + 8, y: spellHandleNode.y() - 22,
          text, fontSize: 13, fontStyle: "bold",
          fill: newData.color, stroke: "#000", strokeWidth: 2, fillAfterStrokeEnabled: true,
          listening: false,
        });
        spellLayer.add(spellResizeLabel);
      }
      spellLayer.batchDraw();
    }
  });
  spellHandleNode.on("dragend", () => {
    spellResizeLabel?.destroy();
    spellResizeLabel = null;
    const newData = applyHandlePos(spellData[id], spellHandleNode.x(), spellHandleNode.y());
    if (newData) {
      spellData[id] = newData;
      window.socketEmit("update_spell_shape", newData);
    }
  });
  spellLayer.add(spellHandleNode);
}

function onSpellShapeMoved(id) {
  const node = spellNodes[id];
  const data = spellData[id];
  if (!node || !data) return;

  let newData;
  if (data.type === "circle") {
    newData = { ...data, cx: node.x() / GRID, cy: node.y() / GRID };
  } else if (data.type === "square") {
    newData = { ...data, x: node.x() / GRID, y: node.y() / GRID };
  } else {
    // cone/line: node.x/y is drag offset
    newData = shiftShapeData(data, node.x() / GRID, node.y() / GRID);
  }

  spellData[id] = newData;
  updateSpellKonvaNode(node, newData);

  if (spellHandleNode) {
    const hp = getResizeHandlePos(newData);
    spellHandleNode.x(hp.x);
    spellHandleNode.y(hp.y);
  }

  spellLayer.batchDraw();
  window.socketEmit("update_spell_shape", newData);
}

function deleteSelectedSpellShape() {
  if (!selectedSpellId) return;
  const id = selectedSpellId;
  deselectSpellShape();
  window.socketEmit("remove_spell_shape", { id });
}
window.deleteSelectedSpellShape = deleteSelectedSpellShape;

function addSpellShapeToMap(shapeData) {
  const wasSelected = selectedSpellId === shapeData.id;
  if (wasSelected) deselectSpellShape();
  removeSpellShapeFromMap(shapeData.id);
  spellData[shapeData.id] = { ...shapeData };
  const node = makeSpellKonvaShape(shapeData.type, shapeData.color, shapeData, false);
  if (node) {
    spellLayer.add(node);
    spellNodes[shapeData.id] = node;
    if (wasSelected) selectSpellShape(shapeData.id);
    spellLayer.batchDraw();
  }
}

function removeSpellShapeFromMap(id) {
  if (selectedSpellId === id) deselectSpellShape();
  const node = spellNodes[id];
  if (node) {
    node.destroy();
    delete spellNodes[id];
    delete spellData[id];
    spellLayer.batchDraw();
  }
}

function clearSpellShapesFromMap() {
  deselectSpellShape();
  spellLayer.destroyChildren();
  Object.keys(spellNodes).forEach(k => delete spellNodes[k]);
  Object.keys(spellData).forEach(k => delete spellData[k]);
  spellLayer.batchDraw();
}

window.addSpellShapeToMap     = addSpellShapeToMap;
window.removeSpellShapeFromMap = removeSpellShapeFromMap;
window.clearSpellShapesFromMap = clearSpellShapesFromMap;

window.setSpellShapeType = (type) => {
  spellShapeType = type;
  document.querySelectorAll(".spell-shape-btn").forEach(b => {
    b.classList.toggle("active", b.dataset.shape === type);
  });
};

window.setSpellShapeColor = (color) => {
  spellShapeColor = color;
  document.querySelectorAll(".spell-color-swatch").forEach(s => {
    s.classList.toggle("active", s.dataset.color === color);
  });
  const input = document.getElementById("spell-color-input");
  if (input) input.value = color;
};

function toggleSpellMode() {
  spellActive = !spellActive;
  setToolActive(rulerActive || pingActive || spellActive);
  stage.draggable(!spellActive && !rulerActive && !selectionActive);
  document.getElementById("spell-btn").classList.toggle("active", spellActive);
  const picker = document.getElementById("spell-picker");
  if (picker) picker.classList.toggle("hidden", !spellActive);
  if (!spellActive) {
    deselectSpellShape();
    spellDraftShape?.destroy();
    spellDraftShape = null;
    spellDraftLabel?.destroy();
    spellDraftLabel = null;
    spellDraftStart = null;
    spellLayer.listening(false);
    spellLayer.batchDraw();
  } else {
    spellLayer.listening(true);
    spellLayer.batchDraw();
  }
}

// Delete selected spell shape via keyboard
document.addEventListener("keydown", (e) => {
  if (!spellActive || !selectedSpellId) return;
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.key === "Delete") {
    e.preventDefault();
    deleteSelectedSpellShape();
  }
});

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
