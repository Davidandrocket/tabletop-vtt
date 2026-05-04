"""Backend procedural dungeon generator for dicecloud.

Port of the infinite_dungeon project's world + generator, with no pygame
dependencies and a JSON serialization layer so a generated dungeon can be
stored in a map_profile row.

Coordinates inside this module are in *world space* (where the spawn room
is centered at (0, 0); negative coords are normal).  When the dungeon is
serialized for the frontend, an origin offset translates all coords into
dicecloud's positive grid.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
import random


# --- Enums (string-valued so JSON round-trips trivially) ---

class CellKind:
    WALL = "wall"
    ROOM_FLOOR = "room_floor"
    HALL_FLOOR = "hall_floor"
    DOOR = "door"


class OpeningKind:
    DOOR = "door"
    HALL_OPEN = "hall_open"


class OpeningState:
    SEALED = "sealed"
    RESOLVED = "resolved"
    BLOCKED = "blocked"


# --- Tunables (mirror config.py from infinite_dungeon) ---

ROOM_SIZE_RANGE = (4, 9)
HALL_SEGMENT_LENGTH = (4, 10)
N_NEW_DOORS_RANGE = (1, 3)
RESOLUTION_RADIUS = 9
REVEAL_BFS_DEPTH = 7
DOOR_PEEK_BFS_DEPTH = 5
MAX_PLACEMENT_ATTEMPTS = 8

DOOR_BEHAVIOR_WEIGHTS = {"room": 60, "hall": 40}
HALL_BEHAVIOR_WEIGHTS = {"straight": 55, "room": 25, "junction": 20}
JUNCTION_EXIT_COUNT_WEIGHTS = {2: 70, 3: 30}

SPAWN_ROOM_SIZE = (6, 6)


# --- Data model ---

@dataclass
class Opening:
    kind: str   # OpeningKind
    x: int
    y: int
    dx: int
    dy: int
    perp_x: int
    perp_y: int
    state: str = OpeningState.SEALED

    def cells(self):
        return [(self.x, self.y), (self.x + self.perp_x, self.y + self.perp_y)]


class World:
    def __init__(self, seed: int):
        self.seed = seed
        # cells: (x, y) -> kind str
        self.cells: dict[tuple[int, int], str] = {}
        self.openings: list[Opening] = []
        self.revealed: set[tuple[int, int]] = set()

    def get(self, x, y):
        return self.cells.get((x, y))

    def set(self, x, y, kind):
        self.cells[(x, y)] = kind

    def has(self, x, y):
        return (x, y) in self.cells

    def is_walkable(self, x, y):
        k = self.cells.get((x, y))
        return k in (CellKind.ROOM_FLOOR, CellKind.HALL_FLOOR, CellKind.DOOR)

    def add_opening(self, op: Opening):
        self.openings.append(op)

    # --- Serialization ---

    def to_dict(self):
        return {
            "seed": self.seed,
            "cells": {f"{x},{y}": k for (x, y), k in self.cells.items()},
            "openings": [
                {"kind": o.kind, "x": o.x, "y": o.y, "dx": o.dx, "dy": o.dy,
                 "perp_x": o.perp_x, "perp_y": o.perp_y, "state": o.state}
                for o in self.openings
            ],
            "revealed": [f"{x},{y}" for (x, y) in self.revealed],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "World":
        w = cls(seed=int(d["seed"]))
        for key, kind in d.get("cells", {}).items():
            x, y = key.split(",")
            w.cells[(int(x), int(y))] = kind
        for od in d.get("openings", []):
            w.openings.append(Opening(
                kind=od["kind"], x=od["x"], y=od["y"],
                dx=od["dx"], dy=od["dy"],
                perp_x=od["perp_x"], perp_y=od["perp_y"],
                state=od.get("state", OpeningState.SEALED),
            ))
        for key in d.get("revealed", []):
            x, y = key.split(",")
            w.revealed.add((int(x), int(y)))
        return w


# --- Cell-level helpers ---

_WALKABLE_KINDS = (CellKind.ROOM_FLOOR, CellKind.HALL_FLOOR, CellKind.DOOR)


def _can_be_floor(world, c):
    return c not in world.cells


def _can_be_wall(world, c):
    k = world.cells.get(c)
    return k is None or k in (CellKind.WALL, CellKind.DOOR)


def _can_be_door(world, c):
    k = world.cells.get(c)
    return k is None or k in (CellKind.WALL, CellKind.DOOR)


def _commit_wall_if_empty(world, c):
    if c not in world.cells:
        world.cells[c] = CellKind.WALL


# --- Room geometry ---

def _wall_ring(rx0, ry0, w, h):
    cells = []
    for x in range(rx0 - 1, rx0 + w + 1):
        cells.append((x, ry0 - 1))
        cells.append((x, ry0 + h))
    for y in range(ry0, ry0 + h):
        cells.append((rx0 - 1, y))
        cells.append((rx0 + w, y))
    return cells


def _interior(rx0, ry0, w, h):
    return [(rx0 + i, ry0 + j) for i in range(w) for j in range(h)]


def place_room(world, rx0, ry0, w, h, door_cells):
    interior = _interior(rx0, ry0, w, h)
    walls = _wall_ring(rx0, ry0, w, h)

    for c in interior:
        if not _can_be_floor(world, c):
            return False
    for c in walls:
        if c in door_cells:
            if not _can_be_door(world, c):
                return False
        else:
            if not _can_be_wall(world, c):
                return False

    for c in interior:
        world.cells[c] = CellKind.ROOM_FLOOR
    for c in walls:
        if c in door_cells:
            world.cells[c] = CellKind.DOOR
        else:
            _commit_wall_if_empty(world, c)
    return True


_SIDE_TO_DIR = {
    "east":  (1, 0, 0, 1),
    "west":  (-1, 0, 0, 1),
    "south": (0, 1, 1, 0),
    "north": (0, -1, 1, 0),
}


def _wall_segment_starts(rx0, ry0, w, h, side):
    if side == "east":
        x = rx0 + w
        for y in range(ry0, ry0 + h - 1):
            yield x, y, 0, 1
    elif side == "west":
        x = rx0 - 1
        for y in range(ry0, ry0 + h - 1):
            yield x, y, 0, 1
    elif side == "south":
        y = ry0 + h
        for x in range(rx0, rx0 + w - 1):
            yield x, y, 1, 0
    elif side == "north":
        y = ry0 - 1
        for x in range(rx0, rx0 + w - 1):
            yield x, y, 1, 0


def _place_doorway_on_wall(world, rx0, ry0, w, h, side, rng):
    dx, dy, perp_x, perp_y = _SIDE_TO_DIR[side]
    candidates = list(_wall_segment_starts(rx0, ry0, w, h, side))
    rng.shuffle(candidates)
    for x, y, px, py in candidates:
        cells = [(x, y), (x + px, y + py)]
        if all(world.cells.get(c) == CellKind.WALL for c in cells):
            for c in cells:
                world.cells[c] = CellKind.DOOR
            world.add_opening(Opening(
                kind=OpeningKind.DOOR,
                x=x, y=y, dx=dx, dy=dy, perp_x=px, perp_y=py,
                state=OpeningState.SEALED,
            ))
            return True
    return False


def _add_room_doorways(world, rx0, ry0, w, h, incoming_side, rng):
    available = [s for s in ("north", "south", "east", "west") if s != incoming_side]
    rng.shuffle(available)
    n = rng.randint(*N_NEW_DOORS_RANGE)
    for side in available[:n]:
        _place_doorway_on_wall(world, rx0, ry0, w, h, side, rng)


def _incoming_side_from_op(op):
    if op.dx == 1:
        return "west"
    if op.dx == -1:
        return "east"
    if op.dy == 1:
        return "north"
    return "south"


def _room_topleft_for_door(op, w, h, rng):
    if op.dx == 1:
        rx0 = op.x + 1
        d_ys = [op.y, op.y + op.perp_y]
        d_min, d_max = min(d_ys), max(d_ys)
        ry0 = rng.randint(d_max - h + 1, d_min)
    elif op.dx == -1:
        rx0 = op.x - w
        d_ys = [op.y, op.y + op.perp_y]
        d_min, d_max = min(d_ys), max(d_ys)
        ry0 = rng.randint(d_max - h + 1, d_min)
    elif op.dy == 1:
        ry0 = op.y + 1
        d_xs = [op.x, op.x + op.perp_x]
        d_min, d_max = min(d_xs), max(d_xs)
        rx0 = rng.randint(d_max - w + 1, d_min)
    else:
        ry0 = op.y - h
        d_xs = [op.x, op.x + op.perp_x]
        d_min, d_max = min(d_xs), max(d_xs)
        rx0 = rng.randint(d_max - w + 1, d_min)
    return rx0, ry0


# --- Hall geometry ---

def place_hall_segment(world, sx, sy, dx, dy, perp_x, perp_y, length):
    floor_cells = []
    wall_cells = []
    for i in range(length):
        a = (sx + i * dx, sy + i * dy)
        b = (a[0] + perp_x, a[1] + perp_y)
        floor_cells.append(a)
        floor_cells.append(b)
        wall_cells.append((a[0] - perp_x, a[1] - perp_y))
        wall_cells.append((a[0] + 2 * perp_x, a[1] + 2 * perp_y))
    for c in floor_cells:
        if not _can_be_floor(world, c):
            return None
    for c in wall_cells:
        if not _can_be_wall(world, c):
            return None
    for c in floor_cells:
        world.cells[c] = CellKind.HALL_FLOOR
    for c in wall_cells:
        _commit_wall_if_empty(world, c)
    return (sx + length * dx, sy + length * dy)


# --- Behaviors ---

def _try_place_room_past_door(world, op, rng):
    door_cells = {(op.x, op.y), (op.x + op.perp_x, op.y + op.perp_y)}
    incoming_side = _incoming_side_from_op(op)
    for _ in range(MAX_PLACEMENT_ATTEMPTS):
        w = rng.randint(*ROOM_SIZE_RANGE)
        h = rng.randint(*ROOM_SIZE_RANGE)
        try:
            rx0, ry0 = _room_topleft_for_door(op, w, h, rng)
        except ValueError:
            continue
        if place_room(world, rx0, ry0, w, h, door_cells):
            _add_room_doorways(world, rx0, ry0, w, h, incoming_side, rng)
            return True
    return False


def _try_place_hall_past_door(world, op, rng):
    sx = op.x + op.dx
    sy = op.y + op.dy
    target = rng.randint(*HALL_SEGMENT_LENGTH)
    for length in range(target, 0, -1):
        end = place_hall_segment(world, sx, sy, op.dx, op.dy, op.perp_x, op.perp_y, length)
        if end is not None:
            world.add_opening(Opening(
                kind=OpeningKind.HALL_OPEN,
                x=end[0], y=end[1],
                dx=op.dx, dy=op.dy, perp_x=op.perp_x, perp_y=op.perp_y,
            ))
            return True
    return False


def _try_extend_hall_straight(world, op, rng):
    target = rng.randint(*HALL_SEGMENT_LENGTH)
    for length in range(target, 0, -1):
        end = place_hall_segment(world, op.x, op.y, op.dx, op.dy, op.perp_x, op.perp_y, length)
        if end is not None:
            world.add_opening(Opening(
                kind=OpeningKind.HALL_OPEN,
                x=end[0], y=end[1],
                dx=op.dx, dy=op.dy, perp_x=op.perp_x, perp_y=op.perp_y,
            ))
            return True
    return False


def _try_open_into_room(world, op, rng):
    door_cells = {(op.x, op.y), (op.x + op.perp_x, op.y + op.perp_y)}
    door_op_synth = Opening(
        kind=OpeningKind.DOOR, x=op.x, y=op.y,
        dx=op.dx, dy=op.dy, perp_x=op.perp_x, perp_y=op.perp_y,
    )
    incoming_side = _incoming_side_from_op(door_op_synth)
    for _ in range(MAX_PLACEMENT_ATTEMPTS):
        w = rng.randint(*ROOM_SIZE_RANGE)
        h = rng.randint(*ROOM_SIZE_RANGE)
        try:
            rx0, ry0 = _room_topleft_for_door(door_op_synth, w, h, rng)
        except ValueError:
            continue
        if place_room(world, rx0, ry0, w, h, door_cells):
            _add_room_doorways(world, rx0, ry0, w, h, incoming_side, rng)
            return True
    return False


def _try_place_junction(world, op, rng):
    dx, dy, px, py = op.dx, op.dy, op.perp_x, op.perp_y
    pad = [
        (op.x + i * dx + j * px, op.y + i * dy + j * py)
        for i in range(2) for j in range(2)
    ]
    forward_cells = [
        (op.x + 2 * dx, op.y + 2 * dy),
        (op.x + 2 * dx + px, op.y + 2 * dy + py),
    ]
    right_cells = [
        (op.x + 2 * px, op.y + 2 * py),
        (op.x + dx + 2 * px, op.y + dy + 2 * py),
    ]
    left_cells = [
        (op.x - px, op.y - py),
        (op.x + dx - px, op.y + dy - py),
    ]
    sides = ["forward", "right", "left"]
    n_exits = rng.choices(
        list(JUNCTION_EXIT_COUNT_WEIGHTS.keys()),
        weights=list(JUNCTION_EXIT_COUNT_WEIGHTS.values()),
        k=1,
    )[0]
    rng.shuffle(sides)
    chosen = set(sides[:n_exits])
    for c in pad:
        if not _can_be_floor(world, c):
            return False
    side_cells = {"forward": forward_cells, "right": right_cells, "left": left_cells}
    for side, cells in side_cells.items():
        if side in chosen:
            for c in cells:
                if not _can_be_floor(world, c):
                    return False
        else:
            for c in cells:
                if not _can_be_wall(world, c):
                    return False
    for c in pad:
        world.cells[c] = CellKind.HALL_FLOOR
    for side, cells in side_cells.items():
        if side not in chosen:
            for c in cells:
                _commit_wall_if_empty(world, c)
    if "forward" in chosen:
        world.add_opening(Opening(
            kind=OpeningKind.HALL_OPEN,
            x=forward_cells[0][0], y=forward_cells[0][1],
            dx=dx, dy=dy, perp_x=px, perp_y=py,
        ))
    if "right" in chosen:
        world.add_opening(Opening(
            kind=OpeningKind.HALL_OPEN,
            x=right_cells[0][0], y=right_cells[0][1],
            dx=px, dy=py, perp_x=dx, perp_y=dy,
        ))
    if "left" in chosen:
        world.add_opening(Opening(
            kind=OpeningKind.HALL_OPEN,
            x=left_cells[0][0], y=left_cells[0][1],
            dx=-px, dy=-py, perp_x=dx, perp_y=dy,
        ))
    return True


# --- Merge with existing geometry ---

def _frontier_cells(op):
    if op.kind == OpeningKind.DOOR:
        return [(op.x + op.dx, op.y + op.dy),
                (op.x + op.perp_x + op.dx, op.y + op.perp_y + op.dy)]
    return [(op.x, op.y), (op.x + op.perp_x, op.y + op.perp_y)]


def _try_merge(world, op):
    front = _frontier_cells(op)
    front_existing = [world.cells.get(c) for c in front]
    if all(e is None for e in front_existing):
        return None
    if all(e is not None and e in _WALKABLE_KINDS for e in front_existing):
        return True
    if all(e == CellKind.WALL for e in front_existing):
        beyond = [(c[0] + op.dx, c[1] + op.dy) for c in front]
        beyond_existing = [world.cells.get(c) for c in beyond]
        if all(e is not None and e in _WALKABLE_KINDS for e in beyond_existing):
            for c in front:
                world.cells[c] = CellKind.DOOR
            return True
        return False
    return False


# --- Resolve dispatcher ---

def _opening_rng(world, op):
    return random.Random(hash((world.seed, op.x, op.y, op.dx, op.dy, op.kind)))


def _weighted_pick(rng, weights):
    keys = list(weights.keys())
    vals = [weights[k] for k in keys]
    return rng.choices(keys, weights=vals, k=1)[0]


def _block_opening(world, op):
    op.state = OpeningState.BLOCKED
    if op.kind == OpeningKind.DOOR:
        for c in op.cells():
            world.cells[c] = CellKind.WALL
    else:
        for c in op.cells():
            _commit_wall_if_empty(world, c)


def resolve_opening(world, op):
    if op.state != OpeningState.SEALED:
        return
    merge = _try_merge(world, op)
    if merge is True:
        op.state = OpeningState.RESOLVED
        return
    if merge is False:
        _block_opening(world, op)
        return
    rng = _opening_rng(world, op)
    if op.kind == OpeningKind.DOOR:
        choice = _weighted_pick(rng, DOOR_BEHAVIOR_WEIGHTS)
        if choice == "room":
            ok = _try_place_room_past_door(world, op, rng)
        else:
            ok = _try_place_hall_past_door(world, op, rng)
    else:
        choice = _weighted_pick(rng, HALL_BEHAVIOR_WEIGHTS)
        if choice == "straight":
            ok = _try_extend_hall_straight(world, op, rng)
        elif choice == "room":
            ok = _try_open_into_room(world, op, rng)
        else:
            ok = _try_place_junction(world, op, rng)
    if ok:
        op.state = OpeningState.RESOLVED
    else:
        _block_opening(world, op)


# --- Tick & reveal ---

def _opening_distance(op, tx, ty):
    a = abs(op.x - tx) + abs(op.y - ty)
    b = abs(op.x + op.perp_x - tx) + abs(op.y + op.perp_y - ty)
    return min(a, b)


def tick(world, token_positions):
    if not token_positions:
        return
    while True:
        progressed = False
        sealed = [o for o in world.openings if o.state == OpeningState.SEALED]
        for op in sealed:
            for tx, ty in token_positions:
                if _opening_distance(op, tx, ty) <= RESOLUTION_RADIUS:
                    resolve_opening(world, op)
                    progressed = True
                    break
        if not progressed:
            break


def force_resolve(world, op):
    if op.state == OpeningState.SEALED:
        resolve_opening(world, op)
    tick(world, [(op.x + op.dx, op.y + op.dy)])


_DIAG_NEIGHBORS = [(-1, 0), (1, 0), (0, -1), (0, 1),
                   (-1, -1), (-1, 1), (1, -1), (1, 1)]
_ORTHO_NEIGHBORS = [(-1, 0), (1, 0), (0, -1), (0, 1)]


def _room_extent(world, x, y):
    if world.cells.get((x, y)) != CellKind.ROOM_FLOOR:
        return set(), set()
    floors = set()
    boundary = set()
    stack = [(x, y)]
    while stack:
        cx, cy = stack.pop()
        if (cx, cy) in floors:
            continue
        if world.cells.get((cx, cy)) != CellKind.ROOM_FLOOR:
            continue
        floors.add((cx, cy))
        for ox, oy in _DIAG_NEIGHBORS:
            nb = (cx + ox, cy + oy)
            nk = world.cells.get(nb)
            if nk in (CellKind.WALL, CellKind.DOOR):
                boundary.add(nb)
        for ox, oy in _ORTHO_NEIGHBORS:
            nb = (cx + ox, cy + oy)
            if nb not in floors:
                stack.append(nb)
    return floors, boundary


def _bfs_reveal_into(world, target, x, y, depth):
    """BFS-flood through floor cells from (x, y), adding revealed cells to
    `target`. Reaching any ROOM_FLOOR floods the entire room (interior +
    bordering walls + bordering doors).

    Doors are leaves: a token sees doors that border its current room/hall
    but BFS never propagates past them, so the room behind a door stays
    hidden until a token actually steps to/through it. Exception: when the
    BFS *starts* on a door (token standing on the threshold), we let it
    enqueue floor neighbors so the player isn't blinded mid-step.
    """
    if (x, y) in world.cells:
        target.add((x, y))
        for ox, oy in _DIAG_NEIGHBORS:
            nb = (x + ox, y + oy)
            if nb in world.cells:
                target.add(nb)
    if not world.is_walkable(x, y):
        return
    start = (x, y)
    visited = {start}
    q = deque([(x, y, 0)])
    while q:
        cx, cy, d = q.popleft()
        k = world.cells.get((cx, cy))
        if k is None:
            continue
        target.add((cx, cy))
        if k == CellKind.ROOM_FLOOR:
            floors, boundary = _room_extent(world, cx, cy)
            for f in floors:
                target.add(f)
                visited.add(f)
            for b in boundary:
                target.add(b)  # walls + doors visible; doors NOT enqueued
        else:
            for ox, oy in _DIAG_NEIGHBORS:
                nb = (cx + ox, cy + oy)
                nk = world.cells.get(nb)
                if nk in (CellKind.WALL, CellKind.DOOR):
                    target.add(nb)
        if d >= depth:
            continue
        # Doors are leaves except when the BFS starts on one.
        if k == CellKind.DOOR and (cx, cy) != start:
            continue
        for ox, oy in _ORTHO_NEIGHBORS:
            nb = (cx + ox, cy + oy)
            if nb in visited:
                continue
            nk = world.cells.get(nb)
            if nk in (CellKind.ROOM_FLOOR, CellKind.HALL_FLOOR):
                visited.add(nb)
                q.append((nb[0], nb[1], d + 1))


def reveal_around(world, x, y, depth=None):
    _bfs_reveal_into(world, world.revealed, x, y,
                     REVEAL_BFS_DEPTH if depth is None else depth)


def update_fog(world, token_positions):
    """Adds visibility from each token to world.revealed.  Returns the set
    of cells currently in any token's sight."""
    visible = set()
    for tx, ty in token_positions:
        _bfs_reveal_into(world, visible, tx, ty, REVEAL_BFS_DEPTH)
    world.revealed |= visible
    return visible


def dm_open_door(world, op):
    force_resolve(world, op)
    reveal_around(world, op.x + op.dx, op.y + op.dy, depth=DOOR_PEEK_BFS_DEPTH)
    reveal_around(world, op.x, op.y, depth=1)


# --- Spawn ---

def init_spawn(world):
    w, h = SPAWN_ROOM_SIZE
    rx0 = -(w // 2)
    ry0 = -(h // 2)
    place_room(world, rx0, ry0, w, h, set())
    rng = random.Random(hash((world.seed, "spawn")))
    for side in ("north", "south", "east", "west"):
        _place_doorway_on_wall(world, rx0, ry0, w, h, side, rng)
    for x in range(rx0 - 1, rx0 + w + 1):
        for y in range(ry0 - 1, ry0 + h + 1):
            if (x, y) in world.cells:
                world.revealed.add((x, y))


def make_world(seed: int) -> World:
    """Build a fresh world with spawn room baked in.  Returns the World."""
    w = World(seed=seed)
    init_spawn(w)
    return w


# --- Wire format helpers ---

def world_to_wire(world: World, origin_x: int, origin_y: int) -> dict:
    """Translate world coords by (origin_x, origin_y) and return the JSON-
    friendly payload the frontend draws.

    cells: dict "col,row" -> kind (in dicecloud's positive grid)
    revealed: list of "col,row" strings
    openings: list with x/y already translated
    """
    cells = {}
    for (x, y), k in world.cells.items():
        cells[f"{x + origin_x},{y + origin_y}"] = k
    revealed = [f"{x + origin_x},{y + origin_y}" for (x, y) in world.revealed]
    openings = [
        {
            "kind": o.kind,
            "x": o.x + origin_x, "y": o.y + origin_y,
            "dx": o.dx, "dy": o.dy,
            "perp_x": o.perp_x, "perp_y": o.perp_y,
            "state": o.state,
        }
        for o in world.openings
    ]
    return {"cells": cells, "openings": openings, "revealed": revealed}
