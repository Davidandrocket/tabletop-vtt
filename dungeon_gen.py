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


# --- Tunables ---
# Gameplay/UX tunables (apply equally to all presets)
RESOLUTION_RADIUS = 9
REVEAL_BFS_DEPTH = 7
DOOR_PEEK_BFS_DEPTH = 5
MAX_PLACEMENT_ATTEMPTS = 8


# Style/shape tunables live in a Preset object hung off each World.  Add
# new presets by appending another entry to PRESETS at the bottom of this
# block; the UI dropdown reads names from there.

@dataclass
class Preset:
    name: str
    room_size_range: tuple        # interior w/h sample range
    hall_segment_length: tuple    # cells per straight segment
    n_new_doors_range: tuple      # extra doorways per new room
    door_behavior_weights: dict   # past a sealed door: room vs hall
    hall_behavior_weights: dict   # at a hall open end: straight/room/junction
    junction_exit_count_weights: dict  # 2-way vs 3-way intersections
    chest_chance: float           # per-roll chest probability (rooms roll twice, dead-ends once)
    spawn_room_size: tuple


PRESET_GENERIC = Preset(
    name="generic",
    room_size_range=(4, 9),
    hall_segment_length=(4, 10),
    n_new_doors_range=(1, 3),
    door_behavior_weights={"room": 60, "hall": 40},
    hall_behavior_weights={"straight": 55, "room": 25, "junction": 20},
    junction_exit_count_weights={2: 70, 3: 30},
    chest_chance=0.25,
    spawn_room_size=(6, 6),
)


# Labyrinth: small rare rooms wedged into a sprawl of corridors and
# intersections. Most generation is hallway, rooms have few doors so they
# tend toward dead-ends, junctions split three-way half the time.
PRESET_LABYRINTH = Preset(
    name="labyrinth",
    room_size_range=(3, 5),
    hall_segment_length=(3, 7),
    n_new_doors_range=(1, 2),
    door_behavior_weights={"room": 20, "hall": 80},
    hall_behavior_weights={"straight": 50, "room": 10, "junction": 40},
    junction_exit_count_weights={2: 50, 3: 50},
    chest_chance=0.30,
    spawn_room_size=(4, 4),
)


PRESETS = {p.name: p for p in (PRESET_GENERIC, PRESET_LABYRINTH)}


def get_preset(name):
    """Look up a preset by name; falls back to GENERIC on unknown name so
    older procedural profiles (pre-presets) keep loading."""
    return PRESETS.get(name) or PRESET_GENERIC


# --- Special rooms ---
# A fraction of new rooms get promoted to a "special" type with distinct
# size/door/chest budgets and a unique floor color on the client.

SPECIAL_ROOM_CHANCE = 0.20

# Once a room is decided to be special, weights pick which type.
SPECIAL_ROOM_TYPE_WEIGHTS = {"boss": 40, "secret": 25, "treasure": 35}

# Per-type overrides applied when a room becomes special. size_range
# overrides preset.room_size_range; n_doors_range overrides
# preset.n_new_doors_range; min/max_chests bound chest rolls for that room.
SPECIAL_ROOM_PROFILES = {
    "boss": {
        "size_range":     (7, 11),
        "n_doors_range":  (0, 1),  # 0-1 *additional* outgoing doors
        "min_chests":     1,
        "max_chests":     2,
    },
    "treasure": {
        "size_range":     (3, 5),
        "n_doors_range":  (0, 0),  # cul-de-sac
        "min_chests":     2,
        "max_chests":     3,
    },
    "secret": {
        "size_range":     (3, 5),
        "n_doors_range":  (0, 0),
        # Always at least one chest so finding a secret room actually pays
        # off — anticlimax of an empty hidden room is worse than no secret.
        "min_chests":     1,
        "max_chests":     2,
    },
}


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
    def __init__(self, seed: int, preset: "Preset | None" = None):
        self.seed = seed
        self.preset = preset or PRESET_GENERIC
        # cells: (x, y) -> kind str
        self.cells: dict[tuple[int, int], str] = {}
        self.openings: list[Opening] = []
        self.revealed: set[tuple[int, int]] = set()
        # chests: cell -> facing direction ("north"|"south"|"east"|"west").
        # The chest sits on a floor cell; the cell stays room/hall_floor for
        # all walkability/flood/merge purposes. Facing is the direction the
        # chest "opens" toward (away from the wall it's against).
        self.chests: dict[tuple[int, int], str] = {}
        # opened_chests: subset of self.chests cells that the DM has marked
        # as opened. Rendered dimmed so DMs can track which loot rooms are
        # done at a glance.
        self.opened_chests: set[tuple[int, int]] = set()
        # special_floors: floor cells of "special" rooms (boss/treasure/
        # secret), tagged so the client can paint them with distinct
        # colors. Cells not in this dict render as their normal kind.
        self.special_floors: dict[tuple[int, int], str] = {}
        # secret_doors: door cells flagged as secret. They function as
        # normal doors (still walkable, BFS still treats them as doors)
        # but render with the wall color (or a near-wall tint) on the
        # client so players have to discover them by trying to walk in.
        self.secret_doors: set[tuple[int, int]] = set()

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
            "preset": self.preset.name,
            "cells": {f"{x},{y}": k for (x, y), k in self.cells.items()},
            "openings": [
                {"kind": o.kind, "x": o.x, "y": o.y, "dx": o.dx, "dy": o.dy,
                 "perp_x": o.perp_x, "perp_y": o.perp_y, "state": o.state}
                for o in self.openings
            ],
            "revealed": [f"{x},{y}" for (x, y) in self.revealed],
            "chests": {f"{x},{y}": facing for (x, y), facing in self.chests.items()},
            "opened_chests": [f"{x},{y}" for (x, y) in self.opened_chests],
            "special_floors": {
                f"{x},{y}": kind for (x, y), kind in self.special_floors.items()
            },
            "secret_doors": [f"{x},{y}" for (x, y) in self.secret_doors],
        }

    @classmethod
    def from_dict(cls, d: dict) -> "World":
        w = cls(seed=int(d["seed"]), preset=get_preset(d.get("preset")))
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
        for key, facing in (d.get("chests") or {}).items():
            x, y = key.split(",")
            w.chests[(int(x), int(y))] = facing
        for key in d.get("opened_chests", []):
            x, y = key.split(",")
            w.opened_chests.add((int(x), int(y)))
        for key, kind in (d.get("special_floors") or {}).items():
            x, y = key.split(",")
            w.special_floors[(int(x), int(y))] = kind
        for key in d.get("secret_doors", []):
            x, y = key.split(",")
            w.secret_doors.add((int(x), int(y)))
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


def _add_room_doorways(world, rx0, ry0, w, h, incoming_side, rng, *, n_range=None):
    available = [s for s in ("north", "south", "east", "west") if s != incoming_side]
    rng.shuffle(available)
    if n_range is None:
        n_range = world.preset.n_new_doors_range
    n = rng.randint(*n_range)
    for side in available[:n]:
        _place_doorway_on_wall(world, rx0, ry0, w, h, side, rng)


def _pick_room_special(world, op):
    """Decide if a room past `op` should be promoted to a special type, and
    if so which. Uses a per-opening RNG separate from the resolution RNG so
    the choice is stable regardless of how many placement attempts ran."""
    rng = random.Random(hash((world.seed, op.x, op.y, op.dx, op.dy, "special")))
    if rng.random() >= SPECIAL_ROOM_CHANCE:
        return None
    keys = list(SPECIAL_ROOM_TYPE_WEIGHTS.keys())
    weights = [SPECIAL_ROOM_TYPE_WEIGHTS[k] for k in keys]
    return rng.choices(keys, weights=weights, k=1)[0]


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

def _resolve_into_room(world, op, rng, *, door_cells, incoming_side, layout_op=None):
    """Shared room-placement: decide special type, sample size + door count
    accordingly, place the room, mark special floors / secret doors, and
    do chest rolls. layout_op overrides which opening is used to compute
    the room's top-left (matters when a HALL_OPEN synthesizes a door)."""
    layout_op = layout_op or op
    special = _pick_room_special(world, op)
    if special:
        size_range = SPECIAL_ROOM_PROFILES[special]["size_range"]
        n_doors_range = SPECIAL_ROOM_PROFILES[special]["n_doors_range"]
    else:
        size_range = world.preset.room_size_range
        n_doors_range = world.preset.n_new_doors_range

    for _ in range(MAX_PLACEMENT_ATTEMPTS):
        w = rng.randint(*size_range)
        h = rng.randint(*size_range)
        try:
            rx0, ry0 = _room_topleft_for_door(layout_op, w, h, rng)
        except ValueError:
            continue
        if place_room(world, rx0, ry0, w, h, door_cells):
            _add_room_doorways(world, rx0, ry0, w, h, incoming_side, rng,
                               n_range=n_doors_range)
            _maybe_place_chests_in_room(world, rx0, ry0, w, h,
                                         _chest_rng(world, op),
                                         special=special)
            if special:
                for x in range(rx0, rx0 + w):
                    for y in range(ry0, ry0 + h):
                        if world.cells.get((x, y)) == CellKind.ROOM_FLOOR:
                            world.special_floors[(x, y)] = special
            if special == "secret":
                for c in door_cells:
                    world.secret_doors.add(c)
            return True
    return False


def _try_place_room_past_door(world, op, rng):
    door_cells = {(op.x, op.y), (op.x + op.perp_x, op.y + op.perp_y)}
    incoming_side = _incoming_side_from_op(op)
    return _resolve_into_room(world, op, rng,
                              door_cells=door_cells,
                              incoming_side=incoming_side)


def _try_place_hall_past_door(world, op, rng):
    sx = op.x + op.dx
    sy = op.y + op.dy
    target = rng.randint(*world.preset.hall_segment_length)
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
    target = rng.randint(*world.preset.hall_segment_length)
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
    return _resolve_into_room(world, op, rng,
                              door_cells=door_cells,
                              incoming_side=incoming_side,
                              layout_op=door_op_synth)


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
        list(world.preset.junction_exit_count_weights.keys()),
        weights=list(world.preset.junction_exit_count_weights.values()),
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
        # Dead-end hall: roll for a chest at the last floor cells
        _maybe_place_chest_in_dead_end(world, op, _chest_rng(world, op))


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
        choice = _weighted_pick(rng, world.preset.door_behavior_weights)
        if choice == "room":
            ok = _try_place_room_past_door(world, op, rng)
        else:
            ok = _try_place_hall_past_door(world, op, rng)
    else:
        choice = _weighted_pick(rng, world.preset.hall_behavior_weights)
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


# --- Chests ---

def _facing_from_dir(dx, dy):
    if dy < 0:
        return "north"
    if dy > 0:
        return "south"
    if dx < 0:
        return "west"
    return "east"


def _chest_candidates_in_room(world, rx0, ry0, w, h):
    """Perimeter floor cells of a room paired with a facing direction (away
    from the wall they're against). Cells whose adjacent wall is a door are
    skipped so we don't put a chest right where someone would walk in.
    Corner cells appear twice (once per touching wall), which is fine — the
    rng picks one of the two orientations."""
    candidates = []
    # Top inner row -> against north wall, opens south
    for i in range(w):
        cell = (rx0 + i, ry0)
        if world.cells.get((cell[0], cell[1] - 1)) != CellKind.DOOR:
            candidates.append((cell, "south"))
    # Bottom inner row -> against south wall, opens north
    for i in range(w):
        cell = (rx0 + i, ry0 + h - 1)
        if world.cells.get((cell[0], cell[1] + 1)) != CellKind.DOOR:
            candidates.append((cell, "north"))
    # Left inner col -> against west wall, opens east
    for j in range(h):
        cell = (rx0, ry0 + j)
        if world.cells.get((cell[0] - 1, cell[1])) != CellKind.DOOR:
            candidates.append((cell, "east"))
    # Right inner col -> against east wall, opens west
    for j in range(h):
        cell = (rx0 + w - 1, ry0 + j)
        if world.cells.get((cell[0] + 1, cell[1])) != CellKind.DOOR:
            candidates.append((cell, "west"))
    return candidates


def _maybe_place_chests_in_room(world, rx0, ry0, w, h, rng, *, special=None):
    """Place chests in the room.

    Normal rooms: 0–2 chests via two independent rolls at preset.chest_chance.
    Special rooms (boss/treasure/secret): use the per-type min/max from
    SPECIAL_ROOM_PROFILES. min_chests are guaranteed; (max - min) optional
    rolls run at preset.chest_chance. Chests sit on perimeter floor cells
    not adjacent to a door; same cell can't be picked twice."""
    candidates = _chest_candidates_in_room(world, rx0, ry0, w, h)
    if not candidates:
        return

    if special and special in SPECIAL_ROOM_PROFILES:
        prof = SPECIAL_ROOM_PROFILES[special]
        min_c = prof.get("min_chests", 0)
        max_c = prof.get("max_chests", 2)
    else:
        min_c, max_c = 0, 2

    def _place():
        nonlocal candidates
        cell, facing = rng.choice(candidates)
        world.chests[cell] = facing
        candidates = [(c, f) for (c, f) in candidates if c != cell]

    for _ in range(min_c):
        if not candidates:
            return
        _place()
    for _ in range(max(0, max_c - min_c)):
        if not candidates:
            return
        if rng.random() >= world.preset.chest_chance:
            continue
        _place()


def _maybe_place_chest_in_dead_end(world, op, rng):
    """Hall just got blocked; the cells one step back from op's front are
    the last hall floor before the cap. Chance for a chest there, facing
    back into the hall."""
    if rng.random() >= world.preset.chest_chance:
        return
    last_a = (op.x - op.dx, op.y - op.dy)
    last_b = (op.x - op.dx + op.perp_x, op.y - op.dy + op.perp_y)
    candidates = [c for c in (last_a, last_b)
                  if world.cells.get(c) == CellKind.HALL_FLOOR]
    if not candidates:
        return
    cell = rng.choice(candidates)
    world.chests[cell] = _facing_from_dir(-op.dx, -op.dy)


def _chest_rng(world, op):
    """Deterministic chest RNG keyed on the opening identity, separate from
    the resolution RNG so chest rolls don't depend on which placement
    attempts succeeded first."""
    return random.Random(hash((world.seed, op.x, op.y, op.dx, op.dy, "chest")))


# --- Spawn ---

def init_spawn(world):
    w, h = world.preset.spawn_room_size
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


def make_world(seed: int, preset_name: str = "generic") -> World:
    """Build a fresh world with spawn room baked in.

    preset_name picks a Preset (see PRESETS); unknown names fall back to
    generic so older callers don't break.
    """
    w = World(seed=seed, preset=get_preset(preset_name))
    init_spawn(w)
    return w


# --- Wire format helpers ---

def world_to_wire(world: World, origin_x: int, origin_y: int) -> dict:
    """Translate world coords by (origin_x, origin_y) and return the JSON-
    friendly payload the frontend draws.

    cells: dict "col,row" -> kind (in dicecloud's positive grid)
    revealed: list of "col,row" strings
    openings: list with x/y already translated
    chests: dict "col,row" -> facing direction
    spawn_marker: list of "col,row" strings (center 2x2 of the spawn room,
        rendered with a distinct tint so players know which room is the start)
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
    chests = {
        f"{x + origin_x},{y + origin_y}": facing
        for (x, y), facing in world.chests.items()
    }
    chests_opened = [
        f"{x + origin_x},{y + origin_y}" for (x, y) in world.opened_chests
    ]
    special_floors = {
        f"{x + origin_x},{y + origin_y}": kind
        for (x, y), kind in world.special_floors.items()
    }
    secret_doors = [
        f"{x + origin_x},{y + origin_y}" for (x, y) in world.secret_doors
    ]
    # Center 2x2 of the spawn room (works for both even-sized presets we ship)
    spawn_marker = []
    for sx, sy in ((-1, -1), (-1, 0), (0, -1), (0, 0)):
        if world.cells.get((sx, sy)) == CellKind.ROOM_FLOOR:
            spawn_marker.append(f"{sx + origin_x},{sy + origin_y}")
    return {
        "cells": cells,
        "openings": openings,
        "revealed": revealed,
        "chests": chests,
        "chests_opened": chests_opened,
        "special_floors": special_floors,
        "secret_doors": secret_doors,
        "spawn_marker": spawn_marker,
    }
