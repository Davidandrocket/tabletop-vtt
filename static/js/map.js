// map.js — Konva battle map

const GRID = 50; // px per cell

// Cell colors for procedural maps (mirrors infinite_dungeon's palette)
const CELL_COLORS = {
  wall:             "#3a3a3e",
  room_floor:       "#8a8a8e",
  hall_floor:       "#636365",
  door:             "#8b4513",
  door_closed:      "#5a3210",
  // Doors that touch a boss room get a distinct red so DMs/players can
  // identify a boss room from any approach (works for original entry
  // doors, additional outgoing doors, and merge-carved doors all).
  boss_door:        "#a83232",
  boss_door_closed: "#6e1f1f",
};

// Center cells of the spawn room get tinted teal so the DM/players can tell
// which room is the starting one at a glance.
const SPAWN_MARKER_COLOR = "#3f7d6f";

// Floor colors for special rooms (override room_floor when present).
const SPECIAL_FLOOR_COLORS = {
  boss:     "#5a2a2e",  // dark crimson
  treasure: "#8a7a3e",  // gold tint
  secret:   "#5a3a6e",  // purple tint
};

// Secret doors render with a wall-ish color so players don't notice them
// at a glance. Slightly off the base wall color so the DM (and observant
// players) can spot them if they look carefully.
const SECRET_DOOR_COLOR = "#3c3a3e";

// Trap overlays painted on top of the floor. DM gets a clear red wash;
// players get a subtle hint they could miss if they aren't paying
// attention. Same hue both ways so a discovery feels coherent.
const TRAP_OVERLAY_DM = "rgba(168, 50, 50, 0.4)";
const TRAP_OVERLAY_PLAYER = "rgba(168, 50, 50, 0.02)";

// chest.svg's default art faces south (opens downward). Rotate clockwise
// by these radians to make it open in other directions:
//   south = 0   west = 90°   north = 180°   east = 270°
const CHEST_ROTATION = {
  south: 0,
  west:  Math.PI / 2,
  north: Math.PI,
  east:  3 * Math.PI / 2,
};

// Single shared <img> for the chest sprite. Loaded once on first render;
// subsequent renders use the cached HTMLImageElement.
let chestImage = null;
function ensureChestImage() {
  if (chestImage !== null) return;
  chestImage = new Image();
  chestImage.onload = () => {
    // Trigger a redraw once the sprite is decoded so chests appear on
    // initial load (sceneFunc skipped them while !complete).
    if (cellLayer) cellLayer.batchDraw();
  };
  chestImage.src = "/static/dungeon/chest.svg";
}

// Module-level mirror of the procedural payload's chest data. Updated on
// every renderProceduralCells; read by the stage click handler and the
// chest-toggle socket listener.
let proceduralChests = {};            // "col,row" -> facing
let proceduralChestsOpened = new Set();  // "col,row" of opened chests
let proceduralTraps = new Set();       // "col,row" of trap cells

// Try to handle a stage click as a chest toggle. Returns true if it took
// the click (and emitted the toggle event); false otherwise. DM only,
// gated to no-tool-active so we don't fight with ruler/spell/fog.
function _tryChestClick() {
  if (document.body.dataset.role !== "dm") return false;
  if (selectionActive || rulerActive || pingActive || spellActive || fogMode) return false;
  if (!stage) return false;
  const cell = stagePointerToCell();
  const key = `${cell.col},${cell.row}`;
  if (!(key in proceduralChests)) return false;
  window.socketEmit?.("procedural_chest_toggle", { col: cell.col, row: cell.row });
  return true;
}

// Called by main.js when the server broadcasts a chest toggle.
function applyChestToggle(col, row, opened) {
  const key = `${col},${row}`;
  if (opened) proceduralChestsOpened.add(key);
  else proceduralChestsOpened.delete(key);
  if (cellLayer) cellLayer.batchDraw();
}
window.applyChestToggle = applyChestToggle;

// Called when the server broadcasts a chest spawn/removal (C-key DM action).
function applyChestChange(col, row, action, facing) {
  const key = `${col},${row}`;
  if (action === "removed") {
    delete proceduralChests[key];
    proceduralChestsOpened.delete(key);
  } else if (action === "placed") {
    proceduralChests[key] = facing;
    proceduralChestsOpened.delete(key);
  }
  if (cellLayer) cellLayer.batchDraw();
}
window.applyChestChange = applyChestChange;

// Called when the server broadcasts a trap spawn/removal (T-key DM action).
function applyTrapChange(col, row, action) {
  const key = `${col},${row}`;
  if (action === "removed") proceduralTraps.delete(key);
  else if (action === "placed") proceduralTraps.add(key);
  if (cellLayer) cellLayer.batchDraw();
}
window.applyTrapChange = applyTrapChange;

// True when a procedural map is currently active. Used by the C-key
// handler to know whether the shortcut applies.
window.hasProceduralMap = () => proceduralBounds !== null;

let stage, imageLayer, gridLayer, fogLayer, tokenLayer, selectionLayer, rulerLayer, pingLayer, spellLayer, cellLayer, stickerLayer;
// Stickers: decorative images placed on the map, draggable/rotatable/resizable by DM
const stickerNodes  = {};  // sticker_id -> Konva.Image
const stickerData   = {};  // sticker_id -> server-side sticker data
let selectedStickerId = null;
let stickerHandleNodes = [];  // [rotateHandle, resizeHandle] when something is selected
const _stickerImageCache = {};  // url -> Promise<HTMLImageElement>
// Bounding box of procedural cells in cell coords, or null when no procedural
// map is active. renderFog reads this to extend the fog overlay past the
// fixed cols/rows grid so a dungeon that grew off-grid still gets fogged.
let proceduralBounds = null;
// Spawn origin in cell coords for the currently active procedural map, or
// null for image / no-map sessions. resetMapView centers on this. Set
// fresh on every renderProceduralCells call.
let proceduralOrigin = null;
// Set by initMap; cleared after the first non-empty procedural render
// auto-centers on spawn. Lets profile switches (which call initMap and
// then later get cells via procedural_state) recenter exactly once
// without re-centering on every subsequent tick broadcast.
let _needsProceduralRecenter = false;
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
// Fog of war paint state
let fogMode = null;      // null | "reveal" | "hide"
let fogDragStart = null;
let fogDragRect = null;

function initMap(cols, rows) {
  currentCols = cols;
  currentRows = rows;
  // Procedural maps want the camera centered on the spawn room rather than
  // top-left. We can't do it here yet (the cell payload arrives separately
  // via procedural_state); flag it so the next non-empty cell render runs
  // resetMapView once.
  _needsProceduralRecenter = true;
  const container = document.getElementById("map-container");

  // Clean up existing stage on reconnect so we don't double-render
  if (stage) {
    stage.destroy();
    Object.keys(tokenNodes).forEach(k => delete tokenNodes[k]);
    Object.keys(spellNodes).forEach(k => delete spellNodes[k]);
    Object.keys(spellData).forEach(k => delete spellData[k]);
    Object.keys(stickerNodes).forEach(k => delete stickerNodes[k]);
    Object.keys(stickerData).forEach(k => delete stickerData[k]);
    selectedSpellId = null;
    spellHandleNode = null;
    selectedStickerId = null;
    stickerHandleNodes = [];
    selectedTokenId = null;
    mapImageNode = null;
    cellLayer = null;
    stickerLayer = null;
    fogDragStart = null;
    fogDragRect = null;
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
  // gridLayer is purely cosmetic (background rect + grid lines, no
  // handlers). Keeping it listenable makes its background rect intercept
  // clicks and break stage-level handlers like chest-toggle and token
  // deselection in no-image / procedural sessions.
  gridLayer = new Konva.Layer({ listening: false });
  cellLayer    = new Konva.Layer({ listening: false });  // procedural cells, painted over gridLayer
  stickerLayer = new Konva.Layer();  // decorative images, draggable for DM
  spellLayer   = new Konva.Layer({ listening: false });
  tokenLayer = new Konva.Layer();
  fogLayer   = new Konva.Layer({ listening: false });
  selectionLayer = new Konva.Layer({ listening: false });
  rulerLayer     = new Konva.Layer({ listening: false });
  pingLayer      = new Konva.Layer({ listening: false });
  stage.add(imageLayer);
  stage.add(gridLayer);
  stage.add(cellLayer);
  stage.add(stickerLayer);
  stage.add(spellLayer);
  stage.add(tokenLayer);
  stage.add(fogLayer);
  stage.add(selectionLayer);
  stage.add(rulerLayer);
  stage.add(pingLayer);

  if (currentMapImage.url) {
    // setMapImage calls drawGrid internally (and skips background rect correctly)
    setMapImage(currentMapImage.url, currentMapImage.offsetX, currentMapImage.offsetY);
  } else {
    drawGrid(cols, rows);
  }

  // Track mouse position for clipboard paste
  stage.on("mousemove", () => { _lastMouseCell = stagePointerToCell(); });

  // Track panning so a pan-end doesn't fire a deselect click
  let stagePanned = false;
  stage.on("dragmove", () => { stagePanned = true; });
  stage.on("click tap", (e) => {
    if (e.target === stage && !stagePanned) {
      // Try chest click first; only deselect if it didn't take the click.
      if (!_tryChestClick()) deselectToken();
    }
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

  // Fog of war: click-drag rectangle to reveal or hide cells
  stage.on("mousedown.fog touchstart.fog", () => {
    if (!fogMode) return;
    fogDragStart = stagePointerToCell();
  });
  stage.on("mousemove.fog touchmove.fog", () => {
    if (!fogMode || !fogDragStart) return;
    const cur = stagePointerToCell();
    const x1 = Math.min(fogDragStart.col, cur.col);
    const y1 = Math.min(fogDragStart.row, cur.row);
    const x2 = Math.max(fogDragStart.col, cur.col);
    const y2 = Math.max(fogDragStart.row, cur.row);
    if (fogDragRect) fogDragRect.destroy();
    fogDragRect = new Konva.Rect({
      x: x1 * GRID, y: y1 * GRID,
      width: (x2 - x1 + 1) * GRID, height: (y2 - y1 + 1) * GRID,
      fill: fogMode === "reveal" ? "rgba(78,204,163,0.25)" : "rgba(255,100,100,0.25)",
      stroke: fogMode === "reveal" ? "#4ECCA3" : "#ff6464",
      strokeWidth: 1.5, dash: [6, 3],
    });
    selectionLayer.add(fogDragRect);
    selectionLayer.batchDraw();
  });
  stage.on("mouseup.fog touchend.fog", () => {
    if (!fogMode || !fogDragStart) return;
    const cur = stagePointerToCell();
    if (fogDragRect) { fogDragRect.destroy(); fogDragRect = null; }
    selectionLayer.batchDraw();
    const c1 = Math.min(fogDragStart.col, cur.col);
    const r1 = Math.min(fogDragStart.row, cur.row);
    const c2 = Math.max(fogDragStart.col, cur.col);
    const r2 = Math.max(fogDragStart.row, cur.row);
    fogDragStart = null;
    const cells = [];
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        cells.push([c, r]);
      }
    }
    window.socketEmit("fog_paint", { cells, mode: fogMode });
  });

  // Handle resize
  window.addEventListener("resize", () => {
    stage.width(container.clientWidth);
    stage.height(container.clientHeight);
    stage.batchDraw();
  });
}

function resetMapView() {
  if (!stage) return;
  stage.scale({ x: 1, y: 1 });
  if (proceduralOrigin) {
    // Center the spawn room (its visual middle is the corner where the
    // four 2x2 marker cells meet, exactly at origin * GRID in pixels).
    const container = document.getElementById("map-container");
    const W = container.clientWidth || 800;
    const H = container.clientHeight || 600;
    stage.position({
      x: W / 2 - proceduralOrigin.x * GRID,
      y: H / 2 - proceduralOrigin.y * GRID,
    });
  } else {
    stage.position({ x: 0, y: 0 });
  }
  stage.batchDraw();
}

// Render the procedural dungeon's cells from a payload sent by the server.
// payload = { cells: { "col,row": kind, ... }, openings: [...], origin_x, origin_y, ... }
// Pass null/undefined to clear.
//
// Uses a single Konva.Shape with a custom sceneFunc instead of one
// Konva.Rect per cell. Cells are grouped by color so we set fillStyle
// once per color and emit raw ctx.fillRect calls. With thousands of
// generated cells this runs in milliseconds — the per-Rect-node version
// stalled visibly on every reveal.
function renderProceduralCells(payload) {
  if (!cellLayer) return;
  cellLayer.destroyChildren();
  if (!payload || !payload.cells) {
    proceduralBounds = null;
    proceduralOrigin = null;
    proceduralChests = {};
    proceduralChestsOpened = new Set();
    proceduralTraps = new Set();
    cellLayer.batchDraw();
    return;
  }
  // Track origin so resetMapView (and the one-shot recenter below) can
  // place the camera over the spawn room.
  proceduralOrigin = (typeof payload.origin_x === "number"
                      && typeof payload.origin_y === "number")
    ? { x: payload.origin_x, y: payload.origin_y }
    : null;

  // Track the bbox so fog rendering can cover cells past the fixed grid.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  const sealedDoorCells = new Set();
  for (const op of (payload.openings || [])) {
    if (op.kind !== "door" || op.state !== "sealed") continue;
    sealedDoorCells.add(`${op.x},${op.y}`);
    sealedDoorCells.add(`${op.x + (op.perp_x || 0)},${op.y + (op.perp_y || 0)}`);
  }

  // Pull the rest of the payload up front so the bucketing loop below can
  // reference them; an earlier iteration declared these *after* the loop
  // and tripped the const-before-init dead-zone.
  ensureChestImage();
  const chests = payload.chests || {};
  proceduralChests = chests;
  proceduralChestsOpened = new Set(payload.chests_opened || []);
  proceduralTraps = new Set(payload.traps || []);
  const spawnMarker = payload.spawn_marker || [];
  const specialFloors = payload.special_floors || {};
  const secretDoors = new Set(payload.secret_doors || []);

  // Bucket cell keys by color so the renderer sets fillStyle once per group.
  // Track bbox in the same pass so we don't iterate twice.
  const byColor = new Map();
  for (const [key, kind] of Object.entries(payload.cells)) {
    const i = key.indexOf(",");
    const c = +key.slice(0, i);
    const r = +key.slice(i + 1);
    if (c < minX) minX = c;
    if (c > maxX) maxX = c;
    if (r < minY) minY = r;
    if (r > maxY) maxY = r;
    let color = CELL_COLORS[kind] || CELL_COLORS.wall;
    if (kind === "door") {
      if (secretDoors.has(key)) {
        // Secret doors mimic walls; secret takes precedence over both
        // sealed-vs-open and boss tinting (else we'd leak the secret).
        color = SECRET_DOOR_COLOR;
      } else if (
        specialFloors[`${c + 1},${r}`] === "boss"
        || specialFloors[`${c - 1},${r}`] === "boss"
        || specialFloors[`${c},${r + 1}`] === "boss"
        || specialFloors[`${c},${r - 1}`] === "boss"
      ) {
        // Adjacency check: any door touching a boss-floor neighbor is a
        // boss door, no matter how it got there (placed by generator,
        // additional outgoing, or merge-carved).
        color = sealedDoorCells.has(key)
          ? CELL_COLORS.boss_door_closed
          : CELL_COLORS.boss_door;
      } else if (sealedDoorCells.has(key)) {
        color = CELL_COLORS.door_closed;
      }
    } else if (kind === "room_floor" && specialFloors[key]) {
      color = SPECIAL_FLOOR_COLORS[specialFloors[key]] || color;
    }
    let bucket = byColor.get(color);
    if (!bucket) { bucket = []; byColor.set(color, bucket); }
    bucket.push(key);
  }
  proceduralBounds = (minX !== Infinity)
    ? { minX, minY, maxX, maxY }
    : null;

  const cellShape = new Konva.Shape({
    listening: false,
    sceneFunc: (ctx) => {
      for (const [color, keys] of byColor) {
        ctx.fillStyle = color;
        for (const key of keys) {
          const i = key.indexOf(",");
          if (i < 0) continue;
          const c = +key.slice(0, i);
          const r = +key.slice(i + 1);
          ctx.fillRect(c * GRID, r * GRID, GRID, GRID);
        }
      }
      // Spawn marker tint paints over the base floor where applicable.
      if (spawnMarker.length) {
        ctx.fillStyle = SPAWN_MARKER_COLOR;
        for (const key of spawnMarker) {
          const i = key.indexOf(",");
          if (i < 0) continue;
          const c = +key.slice(0, i);
          const r = +key.slice(i + 1);
          ctx.fillRect(c * GRID, r * GRID, GRID, GRID);
        }
      }
      // Trap overlay: bright red wash for the DM, faint hint for players.
      // Painted before chest sprites so chest art stays clearly visible.
      if (proceduralTraps.size) {
        ctx.fillStyle = (document.body.dataset.role === "dm")
          ? TRAP_OVERLAY_DM
          : TRAP_OVERLAY_PLAYER;
        for (const key of proceduralTraps) {
          const i = key.indexOf(",");
          if (i < 0) continue;
          const c = +key.slice(0, i);
          const r = +key.slice(i + 1);
          ctx.fillRect(c * GRID, r * GRID, GRID, GRID);
        }
      }
      // Chest sprites on top of cells. Centered + rotated per facing.
      // Opened chests render at reduced opacity so DMs can track which
      // ones have been emptied during the session.
      if (chestImage && chestImage.complete && chestImage.naturalWidth > 0) {
        const half = GRID / 2;
        for (const key in chests) {
          const i = key.indexOf(",");
          if (i < 0) continue;
          const c = +key.slice(0, i);
          const r = +key.slice(i + 1);
          const facing = chests[key];
          const rot = CHEST_ROTATION[facing] || 0;
          ctx.save();
          ctx.translate(c * GRID + half, r * GRID + half);
          if (rot) ctx.rotate(rot);
          if (proceduralChestsOpened.has(key)) ctx.globalAlpha = 0.4;
          ctx.drawImage(chestImage, -half, -half, GRID, GRID);
          ctx.restore();
        }
      }
    },
  });
  cellLayer.add(cellShape);
  cellLayer.batchDraw();

  // First non-empty render after a fresh initMap (session join or profile
  // switch) auto-centers on the spawn room. Subsequent broadcasts (chest
  // toggles, generation ticks) leave the camera alone so the user's pan
  // isn't yanked back every reveal.
  if (_needsProceduralRecenter && proceduralOrigin) {
    _needsProceduralRecenter = false;
    resetMapView();
  }
}
window.renderProceduralCells = renderProceduralCells;

function drawGrid(cols, rows) {
  gridLayer.destroyChildren();
  // Clear any leftover background rects on imageLayer (we re-add below if no image)
  imageLayer.find(".grid-bg").forEach(n => n.destroy());
  const W = cols * GRID;
  const H = rows * GRID;

  // Background — only when there's no map image. Goes on imageLayer (below
  // gridLayer + tokens), so even if state gets out of sync nothing can cover
  // a loaded image with the placeholder bg.
  if (!currentMapImage.url) {
    imageLayer.add(new Konva.Rect({
      x: 0, y: 0, width: W, height: H,
      fill: "#111122",
      name: "grid-bg",
      listening: false,
    }));
    imageLayer.batchDraw();
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

  // Hide token on fogged cells for players
  if (document.body.dataset.role !== "dm" && window.fogRevealed) {
    group.visible(window.fogRevealed.has(`${token.x},${token.y}`));
  }

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

  // Hide token on fogged cells for players
  if (document.body.dataset.role !== "dm" && window.fogRevealed) {
    group.visible(window.fogRevealed.has(`${token.x},${token.y}`));
  }

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
  if (selectedStickerId && typeof deselectSticker === "function") deselectSticker();
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
  // Selecting a spell shape clears sticker selection.
  if (selectedStickerId) deselectSticker();
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
  const flying = token.flying || 0;
  if (conditions.length === 0 && flying <= 0) return;

  const condGroup = new Konva.Group({ name: "cond-group", listening: false });
  group.add(condGroup);

  const uniqueConds = [...new Set(conditions.filter(c => c !== "exhaustion"))];
  const exhCount    = conditions.filter(c => c === "exhaustion").length;

  // Build the horizontal row entries (flying first if active, then conditions)
  const rowEntries = [];
  if (flying > 0) rowEntries.push({ key: "flying", badge: String(flying) });
  uniqueConds.forEach(c => rowEntries.push({ key: c, badge: null }));

  // Y of the top of the horizontal icon row, directly above token
  const rowY = -radius - COND_GAP - COND_SIZE;

  // Draw background + image for a single icon, plus optional badge
  function placeIcon(imgEl, x, y, badge) {
    condGroup.add(new Konva.Rect({
      x, y, width: COND_SIZE, height: COND_SIZE,
      fill: "rgba(0,0,0,0.55)", cornerRadius: 3,
    }));
    condGroup.add(new Konva.Image({
      image: imgEl, x, y, width: COND_SIZE, height: COND_SIZE,
    }));
    if (badge) {
      // Badge in upper-right: dark bg pill with white number
      const badgePadding = 3;
      const badgeText = new Konva.Text({
        text: badge,
        fontSize: 10,
        fontStyle: "bold",
        fill: "#fff",
        listening: false,
      });
      const tw = badgeText.width();
      const bw = tw + badgePadding * 2;
      const bh = 12;
      const bx = x + COND_SIZE - bw / 2;
      const by = y - bh / 2;
      condGroup.add(new Konva.Rect({
        x: bx, y: by, width: bw, height: bh,
        fill: "rgba(0,0,0,0.85)", cornerRadius: 6,
        stroke: "#fff", strokeWidth: 1,
      }));
      badgeText.x(bx + badgePadding);
      badgeText.y(by + 1);
      condGroup.add(badgeText);
    }
    tokenLayer.batchDraw();
  }

  // Horizontal row, centered
  const rowWidth = rowEntries.length * COND_SIZE + Math.max(0, rowEntries.length - 1) * COND_GAP;
  const rowStartX = -(rowWidth / 2);
  rowEntries.forEach((entry, i) => {
    const x = rowStartX + i * (COND_SIZE + COND_GAP);
    loadConditionImage(entry.key).then(img => { if (img) placeIcon(img, x, rowY, entry.badge); });
  });

  // Exhaustion stack, centered, each level stacked vertically above the horizontal row
  for (let i = 0; i < exhCount; i++) {
    const y = rowY - (exhCount - i) * (COND_SIZE + COND_GAP);
    loadConditionImage("exhaustion").then(img => { if (img) placeIcon(img, -(COND_SIZE / 2), y); });
  }
}

// --- Fog of War ---

// Render fog as a single Konva.Shape: fill the whole grid with the fog color,
// then "punch holes" in the revealed cells via destination-out compositing.
// O(revealed) draw calls instead of O(cols*rows), and one Konva node total —
// scales fine to large procedural maps where the old per-cell-rect approach
// melted at ~40k nodes.
function renderFog(fogSet, isDM) {
  if (!fogLayer) return;
  fogLayer.destroyChildren();
  const opacity = isDM ? 0.55 : 1;

  // Default fog rect = the dicecloud grid (0..cols, 0..rows). For procedural
  // maps, expand to also cover the bbox of generated cells so a dungeon
  // that grew past the fixed grid still gets fogged. PAD avoids hairline
  // gaps at the edge of the bbox.
  const PAD = 2;
  let minC = 0, minR = 0;
  let maxC = currentCols, maxR = currentRows;
  if (proceduralBounds) {
    if (proceduralBounds.minX - PAD < minC) minC = proceduralBounds.minX - PAD;
    if (proceduralBounds.minY - PAD < minR) minR = proceduralBounds.minY - PAD;
    if (proceduralBounds.maxX + 1 + PAD > maxC) maxC = proceduralBounds.maxX + 1 + PAD;
    if (proceduralBounds.maxY + 1 + PAD > maxR) maxR = proceduralBounds.maxY + 1 + PAD;
  }
  const x0 = minC * GRID, y0 = minR * GRID;
  const w = (maxC - minC) * GRID, h = (maxR - minR) * GRID;

  // Fill the whole bbox with semi-transparent dark, then "punch out"
  // revealed cells via destination-out. The punches MUST be drawn at
  // full alpha — destination-out removes destination pixels in
  // proportion to the source alpha, so a 0.55-alpha punch over a
  // 0.55-alpha fill leaves 0.45*0.55 ≈ 0.25 residual dim. This was the
  // original DM-only "permanent dim" bug.
  const fogShape = new Konva.Shape({
    listening: false,
    sceneFunc: (ctx) => {
      ctx.save();
      ctx.fillStyle = `rgba(0,0,0,${opacity})`;
      ctx.fillRect(x0, y0, w, h);
      ctx.globalCompositeOperation = "destination-out";
      ctx.fillStyle = "rgba(0,0,0,1)";
      for (const key of fogSet) {
        const i = key.indexOf(",");
        if (i < 0) continue;
        const c = +key.slice(0, i);
        const r = +key.slice(i + 1);
        ctx.fillRect(c * GRID, r * GRID, GRID, GRID);
      }
      ctx.restore();
    },
  });
  fogLayer.add(fogShape);
  fogLayer.batchDraw();
}
window.renderFog = renderFog;

function updateTokenFogVisibility() {
  const isDM = document.body.dataset.role === "dm";
  if (isDM) return;
  const fogSet = window.fogRevealed;
  if (!fogSet) return;
  for (const [tid, grp] of Object.entries(tokenNodes)) {
    const tok = window.getToken(tid);
    if (!tok) continue;
    grp.visible(fogSet.has(`${tok.x},${tok.y}`));
  }
  tokenLayer.batchDraw();
}
window.updateTokenFogVisibility = updateTokenFogVisibility;

function toggleFogMode(mode) {
  fogMode = fogMode === mode ? null : mode;
  const isActive = fogMode !== null;
  stage.draggable(!isActive && !rulerActive && !selectionActive && !spellActive);
  setToolActive(isActive || rulerActive || pingActive || spellActive);
  document.getElementById("fog-reveal-btn")?.classList.toggle("active", fogMode === "reveal");
  document.getElementById("fog-hide-btn")?.classList.toggle("active", fogMode === "hide");
  if (!isActive) {
    fogDragStart = null;
    if (fogDragRect) { fogDragRect.destroy(); fogDragRect = null; }
    selectionLayer.batchDraw();
  }
}
window.toggleFogMode = toggleFogMode;

// Track mouse cell for paste operations
let _lastMouseCell = { col: 0, row: 0 };
window.getLastMouseCell = () => ({ ..._lastMouseCell });
window.getSelectedSpellId = () => selectedSpellId;
window.getSpellData = (id) => spellData[id] ? { ...spellData[id] } : null;

// Convert browser client coordinates to grid cell (accounting for stage pan/zoom)
window.clientCoordsToCell = (clientX, clientY) => {
  const container = document.getElementById("map-container");
  const rect = container.getBoundingClientRect();
  const scale = stage.scaleX();
  const pos = stage.position();
  const canvasX = (clientX - rect.left - pos.x) / scale;
  const canvasY = (clientY - rect.top  - pos.y) / scale;
  return { col: Math.floor(canvasX / GRID), row: Math.floor(canvasY / GRID) };
};


// ───── Stickers ─────
// Decorative images placed on the map. Render below spell shapes & tokens
// (so creatures/AoE always appear on top). All roles can drag/rotate/resize/
// delete — stickers are intentionally collaborative.

const STICKER_HANDLE_SIZE = 12;
const STICKER_HANDLE_GAP  = 18;  // distance from sticker edge to rotation handle

function _loadStickerImage(url) {
  if (!_stickerImageCache[url]) {
    _stickerImageCache[url] = new Promise(resolve => {
      const img = new Image();
      img.onload  = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }
  return _stickerImageCache[url];
}

// --- Animated sticker decoding ---
// Chromium pauses GIF/WebP animation on non-visible elements, so attaching
// an Image to a hidden DOM container doesn't keep frames progressing. We
// decode the frames ourselves with the native ImageDecoder API, then paint
// the current frame to a per-sticker <canvas> on every RAF tick. Konva.Image
// reads from the canvas via drawImage, so it always shows the latest frame.
const _animatedStickerAssets = {};  // sticker_id -> { canvas, ctx, frames, totalDurationMs, startTime, naturalW, naturalH }

async function _decodeAnimatedSticker(url) {
  // Returns { frames, totalDurationMs, naturalW, naturalH } or null on failure / single frame.
  if (typeof ImageDecoder === "undefined") return null;
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    // Pick MIME from URL extension; server's content-type can be wrong
    // (e.g. Windows Flask serves .webp as application/octet-stream, which
    // ImageDecoder rejects).
    const lower = url.toLowerCase();
    let type;
    if      (lower.endsWith(".gif"))  type = "image/gif";
    else if (lower.endsWith(".webp")) type = "image/webp";
    else if (lower.endsWith(".png"))  type = "image/png";
    else                              type = resp.headers.get("content-type") || "image/webp";
    const buf = await resp.arrayBuffer();
    const decoder = new ImageDecoder({ data: buf, type });
    // tracks.ready resolves once tracks are known, but frameCount may
    // still be null for animated WebP. Await `completed` so we know the
    // full frame count before we decide animated vs static.
    await decoder.tracks.ready;
    if (decoder.completed) {
      try { await decoder.completed; } catch (_) { /* some browsers don't support completed yet */ }
    }
    const track = decoder.tracks.selectedTrack;
    // Defensive: null <= 1 evaluates true in JS, which would silently bail. Cast to a real number.
    const rawCount = track?.frameCount;
    const frameCount = (typeof rawCount === "number" && rawCount > 0) ? rawCount : 0;
    if (frameCount <= 1) { decoder.close(); return null; }
    const frames = [];
    let totalDurationMs = 0;
    let naturalW = 0, naturalH = 0;
    for (let i = 0; i < frameCount; i++) {
      const result = await decoder.decode({ frameIndex: i });
      const vf = result.image;
      const bitmap = await createImageBitmap(vf);
      // VideoFrame.duration is in microseconds (or null if unknown — fall back to 100ms)
      const durMs = vf.duration ? Math.max(20, vf.duration / 1000) : 100;
      frames.push({ bitmap, durationMs: durMs });
      totalDurationMs += durMs;
      if (!naturalW) { naturalW = bitmap.width; naturalH = bitmap.height; }
      vf.close();
    }
    decoder.close();
    return { frames, totalDurationMs, naturalW, naturalH };
  } catch (e) {
    console.warn("Sticker animation decode failed for", url, e);
    return null;
  }
}

async function _setupAnimatedStickerFor(stickerId, url, node) {
  const asset = await _decodeAnimatedSticker(url);
  if (!asset) return;  // not animated, or decode failed — leaves static image in place
  const canvas = document.createElement("canvas");
  canvas.width  = asset.naturalW;
  canvas.height = asset.naturalH;
  const ctx = canvas.getContext("2d");
  // Paint frame 0 immediately so we don't show a blank canvas before the loop starts.
  ctx.drawImage(asset.frames[0].bitmap, 0, 0);
  _animatedStickerAssets[stickerId] = {
    canvas, ctx,
    frames: asset.frames,
    totalDurationMs: asset.totalDurationMs,
    startTime: performance.now(),
    lastFrameIdx: -1,
  };
  // Swap Konva source to our live canvas
  node.image(canvas);
  stickerLayer?.batchDraw();
  _ensureStickerAnimationLoop();
}

function _disposeAnimatedSticker(stickerId) {
  const asset = _animatedStickerAssets[stickerId];
  if (!asset) return;
  for (const f of asset.frames) f.bitmap.close?.();
  delete _animatedStickerAssets[stickerId];
}

// RAF loop that advances each animated sticker's canvas to the right
// frame based on elapsed wall-clock time. Konva re-reads from each
// canvas on batchDraw and shows the latest frame.
let _stickerRafId = null;
function _isAnimatedStickerUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return lower.endsWith(".gif") || lower.endsWith(".webp");
}
function _ensureStickerAnimationLoop() {
  if (_stickerRafId !== null) return;
  if (!stickerLayer) return;
  if (Object.keys(_animatedStickerAssets).length === 0) return;
  const tick = () => {
    const ids = Object.keys(_animatedStickerAssets);
    if (ids.length === 0 || !stickerLayer) {
      _stickerRafId = null;
      return;
    }
    const now = performance.now();
    let anyAdvanced = false;
    for (const id of ids) {
      const asset = _animatedStickerAssets[id];
      const elapsed = (now - asset.startTime) % asset.totalDurationMs;
      let acc = 0;
      let frameIdx = 0;
      for (let i = 0; i < asset.frames.length; i++) {
        acc += asset.frames[i].durationMs;
        if (elapsed < acc) { frameIdx = i; break; }
      }
      if (frameIdx !== asset.lastFrameIdx) {
        asset.ctx.clearRect(0, 0, asset.canvas.width, asset.canvas.height);
        asset.ctx.drawImage(asset.frames[frameIdx].bitmap, 0, 0);
        asset.lastFrameIdx = frameIdx;
        anyAdvanced = true;
      }
    }
    if (anyAdvanced) stickerLayer.batchDraw();
    _stickerRafId = requestAnimationFrame(tick);
  };
  _stickerRafId = requestAnimationFrame(tick);
}

function _stickerCenterPx(s) {
  return {
    x: (s.x + s.width  / 2) * GRID,
    y: (s.y + s.height / 2) * GRID,
  };
}

function addStickerToMap(sticker) {
  if (!stickerLayer) return;
  // Replace if already present (sticker_added after redraw)
  if (stickerNodes[sticker.id]) {
    updateStickerOnMap(sticker);
    return;
  }
  stickerData[sticker.id] = { ...sticker };
  // Honor the DM's sticker-permission toggle when creating the node for players
  const isDM = document.body.dataset.role === "dm";
  const playerCanUse = window._playersCanUseStickers !== false;
  const interactive = isDM || playerCanUse;
  const node = new Konva.Image({
    image: null,  // set when loaded
    width:  sticker.width  * GRID,
    height: sticker.height * GRID,
    offsetX: (sticker.width  * GRID) / 2,
    offsetY: (sticker.height * GRID) / 2,
    x: (sticker.x + sticker.width  / 2) * GRID,
    y: (sticker.y + sticker.height / 2) * GRID,
    rotation: sticker.rotation || 0,
    draggable: interactive,
    listening: interactive,
    name: `sticker-${sticker.id}`,
  });
  node._stickerId = sticker.id;
  stickerLayer.add(node);
  _loadStickerImage(sticker.image_url).then(img => {
    if (img) { node.image(img); stickerLayer.batchDraw(); }
  });
  node.on("click tap", (e) => {
    e.cancelBubble = true;
    selectSticker(sticker.id);
  });
  node.on("dragend", () => {
    const s = stickerData[sticker.id];
    if (!s) return;
    const newX = node.x() / GRID - s.width  / 2;
    const newY = node.y() / GRID - s.height / 2;
    s.x = newX; s.y = newY;
    window.socketEmit?.("update_sticker", { id: sticker.id, x: newX, y: newY });
    if (selectedStickerId === sticker.id) _updateStickerHandlePositions();
  });
  node.on("dragmove", () => {
    if (selectedStickerId === sticker.id) _updateStickerHandlePositions();
  });
  stickerNodes[sticker.id] = node;
  stickerLayer.batchDraw();
  if (_isAnimatedStickerUrl(sticker.image_url)) {
    _setupAnimatedStickerFor(sticker.id, sticker.image_url, node);
  }
}
window.addStickerToMap = addStickerToMap;

function updateStickerOnMap(sticker) {
  const node = stickerNodes[sticker.id];
  if (!node) { addStickerToMap(sticker); return; }
  const prev = stickerData[sticker.id];
  stickerData[sticker.id] = { ...sticker };
  const wPx = sticker.width  * GRID;
  const hPx = sticker.height * GRID;
  node.width(wPx);
  node.height(hPx);
  node.offsetX(wPx / 2);
  node.offsetY(hPx / 2);
  node.x((sticker.x + sticker.width  / 2) * GRID);
  node.y((sticker.y + sticker.height / 2) * GRID);
  node.rotation(sticker.rotation || 0);
  // Only reload the underlying image source if the URL actually changed.
  // Important: don't clobber an animated sticker's live canvas with the
  // static <img> on every move/rotate/resize.
  const urlChanged = !prev || prev.image_url !== sticker.image_url;
  if (urlChanged && sticker.image_url) {
    _disposeAnimatedSticker(sticker.id);
    _loadStickerImage(sticker.image_url).then(img => {
      if (img) { node.image(img); stickerLayer.batchDraw(); }
    });
    if (_isAnimatedStickerUrl(sticker.image_url)) {
      _setupAnimatedStickerFor(sticker.id, sticker.image_url, node);
    }
  }
  if (selectedStickerId === sticker.id) _updateStickerHandlePositions();
  stickerLayer.batchDraw();
}
window.updateStickerOnMap = updateStickerOnMap;

function removeStickerFromMap(id) {
  if (selectedStickerId === id) deselectSticker();
  const node = stickerNodes[id];
  if (node) { node.destroy(); delete stickerNodes[id]; }
  delete stickerData[id];
  _disposeAnimatedSticker(id);
  stickerLayer?.batchDraw();
}
window.removeStickerFromMap = removeStickerFromMap;

// Toggle drag/click on all placed stickers when the DM flips the
// "players can use stickers" switch. DM is never affected.
function _setStickerInteractivityForRole(canUse) {
  if (document.body.dataset.role === "dm") return;
  for (const id in stickerNodes) {
    const node = stickerNodes[id];
    node.draggable(canUse);
    node.listening(canUse);
  }
  if (!canUse) deselectSticker();
  stickerLayer?.batchDraw();
}
window._setStickerInteractivityForRole = _setStickerInteractivityForRole;

function clearStickersFromMap() {
  deselectSticker();
  for (const id of Object.keys(_animatedStickerAssets)) _disposeAnimatedSticker(id);
  if (stickerLayer) stickerLayer.destroyChildren();
  Object.keys(stickerNodes).forEach(k => delete stickerNodes[k]);
  Object.keys(stickerData).forEach(k => delete stickerData[k]);
  stickerLayer?.batchDraw();
}
window.clearStickersFromMap = clearStickersFromMap;

function selectSticker(id) {
  if (selectedStickerId === id) return;
  if (selectedStickerId) deselectSticker();
  // Selecting a sticker clears any token or spell shape selection so
  // the three selection modes stay mutually exclusive.
  if (selectedTokenId || (selectedTokenIds && selectedTokenIds.size > 0)) {
    deselectToken();
  }
  if (selectedSpellId) deselectSpellShape();
  const node = stickerNodes[id];
  if (!node) return;
  selectedStickerId = id;
  node.stroke("#4a90d9");
  node.strokeWidth(2);
  _addStickerHandles(id);
  stickerLayer.batchDraw();
}
window.selectSticker = selectSticker;

function deselectSticker() {
  if (!selectedStickerId) return;
  const node = stickerNodes[selectedStickerId];
  if (node) {
    node.stroke(null);
    node.strokeWidth(0);
  }
  for (const h of stickerHandleNodes) h.destroy();
  stickerHandleNodes = [];
  selectedStickerId = null;
  stickerLayer?.batchDraw();
}
window.deselectSticker = deselectSticker;

function _addStickerHandles(id) {
  for (const h of stickerHandleNodes) h.destroy();
  stickerHandleNodes = [];
  const s = stickerData[id];
  if (!s) return;

  // Rotation handle — green circle above sticker
  const rot = new Konva.Circle({
    radius: STICKER_HANDLE_SIZE / 2,
    fill: "#2e7d32", stroke: "#fff", strokeWidth: 1.5,
    draggable: true, name: "sticker-rot-handle",
  });
  // Resize handle — blue square at bottom-right corner
  const res = new Konva.Rect({
    width: STICKER_HANDLE_SIZE, height: STICKER_HANDLE_SIZE,
    offsetX: STICKER_HANDLE_SIZE / 2, offsetY: STICKER_HANDLE_SIZE / 2,
    fill: "#4a90d9", stroke: "#fff", strokeWidth: 1.5,
    cornerRadius: 2,
    draggable: true, name: "sticker-resize-handle",
  });
  rot.on("mouseover", () => { document.body.style.cursor = "grab"; });
  rot.on("mouseout",  () => { document.body.style.cursor = "default"; });
  res.on("mouseover", () => { document.body.style.cursor = "nwse-resize"; });
  res.on("mouseout",  () => { document.body.style.cursor = "default"; });

  // Rotation handle drag: follow cursor freely (don't reset its position
  // mid-drag), compute the sticker's rotation from the handle's angle
  // around center. _updateStickerHandlePositions only touches the resize
  // handle during a rotation drag to avoid fighting Konva's drag.
  rot.on("dragmove", () => {
    const cur = stickerData[selectedStickerId];
    if (!cur) return;
    const c = _stickerCenterPx(cur);
    const dx = rot.x() - c.x;
    const dy = rot.y() - c.y;
    // Rotation handle's "natural" position is above center (angle = -90°).
    const angleDeg = Math.atan2(dy, dx) * 180 / Math.PI + 90;
    cur.rotation = angleDeg;
    const node = stickerNodes[selectedStickerId];
    node.rotation(angleDeg);
    _updateStickerHandlePositions({ skipRotate: true });
    stickerLayer.batchDraw();
  });
  rot.on("dragend", () => {
    const cur = stickerData[selectedStickerId];
    if (!cur) return;
    window.socketEmit?.("update_sticker", { id: selectedStickerId, rotation: cur.rotation });
    _updateStickerHandlePositions();  // snap to canonical
  });

  // Resize handle drag. Capture both starting dimensions AND a fixed
  // center reference at dragstart. Using a static center prevents the
  // feedback loop where mutating cur.width mid-drag shifts the center
  // mid-frame and creates jitter. cur.x / cur.y also get updated each
  // tick to keep the center anchored, so the server roundtrip on
  // dragend doesn't snap the sticker to a different position.
  let _resizeStart = null;
  res.on("dragstart", () => {
    const cur = stickerData[selectedStickerId];
    if (!cur) { _resizeStart = null; return; }
    _resizeStart = {
      width: cur.width,
      height: cur.height,
      halfWPx: cur.width  * GRID / 2,
      halfHPx: cur.height * GRID / 2,
      // Fixed center in stage px — does NOT recompute each frame
      centerXPx: (cur.x + cur.width  / 2) * GRID,
      centerYPx: (cur.y + cur.height / 2) * GRID,
      rotationRad: cur.rotation * Math.PI / 180,
    };
  });
  res.on("dragmove", (e) => {
    const cur = stickerData[selectedStickerId];
    if (!cur || !_resizeStart) return;
    const dx = res.x() - _resizeStart.centerXPx;
    const dy = res.y() - _resizeStart.centerYPx;
    // Unrotate into the sticker's local frame
    const angRad = -_resizeStart.rotationRad;
    const cosA = Math.cos(angRad);
    const sinA = Math.sin(angRad);
    const localDx = dx * cosA - dy * sinA;
    const localDy = dx * sinA + dy * cosA;
    let newWidth, newHeight;
    const freeResize = !!(e.evt && e.evt.shiftKey);
    if (freeResize) {
      newWidth  = (2 * localDx) / GRID;
      newHeight = (2 * localDy) / GRID;
    } else {
      // Aspect-locked — dominant axis drives both, preserving start ratio
      const sx = localDx / _resizeStart.halfWPx;
      const sy = localDy / _resizeStart.halfHPx;
      const scale = Math.max(sx, sy);
      newWidth  = _resizeStart.width  * scale;
      newHeight = _resizeStart.height * scale;
    }
    newWidth  = Math.max(0.25, Math.min(50, newWidth));
    newHeight = Math.max(0.25, Math.min(50, newHeight));
    cur.width  = newWidth;
    cur.height = newHeight;
    // Update x/y so the CENTER stays anchored to the dragstart center.
    // This keeps the model consistent with what the user sees and
    // prevents the snap-back when the server echoes back the update.
    cur.x = _resizeStart.centerXPx / GRID - newWidth  / 2;
    cur.y = _resizeStart.centerYPx / GRID - newHeight / 2;
    const node = stickerNodes[selectedStickerId];
    const wPx = newWidth  * GRID, hPx = newHeight * GRID;
    node.width(wPx);
    node.height(hPx);
    node.offsetX(wPx / 2);
    node.offsetY(hPx / 2);
    // node.x() / node.y() = center, unchanged (still the dragstart center)
    node.x(_resizeStart.centerXPx);
    node.y(_resizeStart.centerYPx);
    _updateStickerHandlePositions({ skipResize: true });
    stickerLayer.batchDraw();
  });
  res.on("dragend", () => {
    _resizeStart = null;
    const cur = stickerData[selectedStickerId];
    if (!cur) return;
    window.socketEmit?.("update_sticker", {
      id: selectedStickerId,
      x: cur.x, y: cur.y,
      width: cur.width, height: cur.height,
    });
    _updateStickerHandlePositions();  // snap resize handle back to corner
  });

  stickerLayer.add(rot);
  stickerLayer.add(res);
  stickerHandleNodes = [rot, res];
  _updateStickerHandlePositions();
}

function _updateStickerHandlePositions(opts) {
  if (!selectedStickerId || stickerHandleNodes.length < 2) return;
  const s = stickerData[selectedStickerId];
  if (!s) return;
  const skipRotate = !!(opts && opts.skipRotate);
  const skipResize = !!(opts && opts.skipResize);
  const c = _stickerCenterPx(s);
  const halfW = s.width  * GRID / 2;
  const halfH = s.height * GRID / 2;
  const angRad = s.rotation * Math.PI / 180;
  const cosA = Math.cos(angRad);
  const sinA = Math.sin(angRad);

  if (!skipRotate) {
    // Rotation handle: local (0, -halfH - GAP) → rotate → add center
    const rotLocalY = -halfH - STICKER_HANDLE_GAP;
    const rotX = c.x + (0 * cosA - rotLocalY * sinA);
    const rotY = c.y + (0 * sinA + rotLocalY * cosA);
    stickerHandleNodes[0].x(rotX);
    stickerHandleNodes[0].y(rotY);
  }
  if (!skipResize) {
    // Resize handle: local (halfW, halfH) → rotate → add center
    const resX = c.x + (halfW * cosA - halfH * sinA);
    const resY = c.y + (halfW * sinA + halfH * cosA);
    stickerHandleNodes[1].x(resX);
    stickerHandleNodes[1].y(resY);
  }
}

// Delete selected sticker on Del / Backspace (any role, no input focused)
window.addEventListener("keydown", (e) => {
  if (!selectedStickerId) return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || document.activeElement?.isContentEditable) return;
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    const id = selectedStickerId;
    window.socketEmit?.("remove_sticker", { id });
  }
});

// Note: main.js's onTokenSelected calls deselectSticker() to keep token
// and sticker selection mutually exclusive. No need to wrap from here.
