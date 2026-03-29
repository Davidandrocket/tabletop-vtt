from gevent import monkey
monkey.patch_all()

import os
import json
import uuid
import random
import string
import re
import sqlite3
import requests
from flask import Flask, render_template, request, session, redirect, url_for
from flask_socketio import SocketIO, join_room, emit
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "dev-secret-change-in-prod")
socketio = SocketIO(app, cors_allowed_origins="*")

DICECLOUD_BASE = "https://dicecloud.com/api"
DB_PATH = os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "sessions.db"))
UPLOAD_FOLDER = os.environ.get("UPLOAD_FOLDER", os.path.join(os.path.dirname(__file__), "static", "uploads"))
ALLOWED_IMAGE_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp"}

# --- In-memory state (ephemeral per-connection data only) ---
sessions = {}       # code -> session data
socket_info = {}    # socket_id -> {code, role, name}


# --- Database ---

def get_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                code             TEXT PRIMARY KEY,
                dm_name          TEXT,
                map_cols         INTEGER DEFAULT 20,
                map_rows         INTEGER DEFAULT 15,
                initiative_order TEXT    DEFAULT '[]',
                current_turn     INTEGER DEFAULT -1
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tokens (
                id           TEXT PRIMARY KEY,
                session_code TEXT,
                name         TEXT,
                x            INTEGER DEFAULT 0,
                y            INTEGER DEFAULT 0,
                hp           INTEGER DEFAULT 10,
                max_hp       INTEGER DEFAULT 10,
                color        TEXT    DEFAULT '#e74c3c',
                is_player    INTEGER DEFAULT 0,
                player_id    TEXT,
                initiative   INTEGER DEFAULT 0,
                conditions   TEXT    DEFAULT '[]'
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS chat (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                session_code TEXT,
                data         TEXT
            )
        """)
        # Migrations: add columns introduced after initial schema
        for col, defn in [
            ("image_url", "TEXT"),
            ("size",      "INTEGER DEFAULT 1"),
            ("hidden",    "INTEGER DEFAULT 0"),
        ]:
            try:
                conn.execute(f"ALTER TABLE tokens ADD COLUMN {col} {defn}")
            except sqlite3.OperationalError:
                pass  # already exists
        for col, defn in [
            ("map_image_url",    "TEXT"),
            ("map_offset_x",     "REAL DEFAULT 0"),
            ("map_offset_y",     "REAL DEFAULT 0"),
            ("map_image_scale",  "REAL DEFAULT 1"),   # used as scale_x
            ("map_image_scale_y","REAL DEFAULT 1"),
        ]:
            try:
                conn.execute(f"ALTER TABLE sessions ADD COLUMN {col} {defn}")
            except sqlite3.OperationalError:
                pass  # already exists

        conn.execute("""
            CREATE TABLE IF NOT EXISTS player_characters (
                session_code   TEXT,
                player_uuid    TEXT,
                character_id   TEXT NOT NULL DEFAULT '',
                character_data TEXT,
                PRIMARY KEY (session_code, player_uuid, character_id)
            )
        """)
        # Migration: if old table lacks character_id column, recreate with it in the PK
        cols = {row[1] for row in conn.execute("PRAGMA table_info(player_characters)").fetchall()}
        if "character_id" not in cols:
            conn.execute("""
                CREATE TABLE player_characters_new (
                    session_code   TEXT,
                    player_uuid    TEXT,
                    character_id   TEXT NOT NULL DEFAULT '',
                    character_data TEXT,
                    PRIMARY KEY (session_code, player_uuid, character_id)
                )
            """)
            conn.execute("""
                INSERT INTO player_characters_new (session_code, player_uuid, character_id, character_data)
                SELECT session_code, player_uuid, '', character_data FROM player_characters
            """)
            conn.execute("DROP TABLE player_characters")
            conn.execute("ALTER TABLE player_characters_new RENAME TO player_characters")


def db_session_exists(code):
    with get_db() as conn:
        row = conn.execute(
            "SELECT 1 FROM sessions WHERE code = ?", (code,)
        ).fetchone()
        return row is not None


def db_save_session(code):
    sess = sessions[code]
    with get_db() as conn:
        conn.execute("""
            INSERT OR REPLACE INTO sessions
                (code, dm_name, map_cols, map_rows, initiative_order, current_turn,
                 map_image_url, map_offset_x, map_offset_y, map_image_scale, map_image_scale_y)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            code,
            sess["dm_name"],
            sess["map"]["cols"],
            sess["map"]["rows"],
            json.dumps(sess["initiative_order"]),
            sess["current_turn"],
            sess["map"].get("image_url"),
            sess["map"].get("offset_x", 0),
            sess["map"].get("offset_y", 0),
            sess["map"].get("scale_x", 1),
            sess["map"].get("scale_y", 1),
        ))


def db_upsert_token(token, code):
    with get_db() as conn:
        conn.execute("""
            INSERT OR REPLACE INTO tokens
                (id, session_code, name, x, y, hp, max_hp,
                 color, is_player, player_id, initiative, conditions,
                 image_url, size, hidden)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            token["id"], code, token["name"],
            token["x"], token["y"],
            token["hp"], token["max_hp"],
            token["color"],
            1 if token.get("is_player") else 0,
            token.get("player_id"),
            token.get("initiative", 0),
            json.dumps(token.get("conditions", [])),
            token.get("image_url"),
            token.get("size", 1),
            1 if token.get("hidden") else 0,
        ))


def db_delete_token(token_id):
    with get_db() as conn:
        conn.execute("DELETE FROM tokens WHERE id = ?", (token_id,))


def db_append_chat(msg, code):
    with get_db() as conn:
        conn.execute(
            "INSERT INTO chat (session_code, data) VALUES (?, ?)",
            (code, json.dumps(msg)),
        )
        # Cap at 200 stored messages per session
        conn.execute("""
            DELETE FROM chat
            WHERE session_code = ? AND id NOT IN (
                SELECT id FROM chat WHERE session_code = ? ORDER BY id DESC LIMIT 200
            )
        """, (code, code))


def db_load_session(code):
    """Pull a session from the DB into the in-memory dict. Returns True if found."""
    conn = get_db()
    row = conn.execute(
        "SELECT * FROM sessions WHERE code = ?", (code,)
    ).fetchone()
    if not row:
        return False

    token_rows = conn.execute(
        "SELECT * FROM tokens WHERE session_code = ?", (code,)
    ).fetchall()

    chat_rows = conn.execute(
        "SELECT data FROM chat WHERE session_code = ? ORDER BY id DESC LIMIT 50",
        (code,),
    ).fetchall()

    tokens = {}
    for t in token_rows:
        token = dict(t)
        token["is_player"] = bool(token["is_player"])
        token["hidden"]    = bool(token.get("hidden", 0))
        token["conditions"] = json.loads(token.get("conditions") or "[]")
        tokens[token["id"]] = token

    sessions[code] = {
        "dm_name": row["dm_name"],
        "dm_socket": None,
        "players": {},
        "tokens": tokens,
        "initiative_order": json.loads(row["initiative_order"] or "[]"),
        "current_turn": row["current_turn"],
        "map": {
            "cols": row["map_cols"], "rows": row["map_rows"], "grid_size": 50,
            "image_url": row["map_image_url"],
            "offset_x": row["map_offset_x"] or 0,
            "offset_y": row["map_offset_y"] or 0,
            "scale_x": row["map_image_scale"]   if row["map_image_scale"]   is not None else 1,
            "scale_y": row["map_image_scale_y"] if row["map_image_scale_y"] is not None else 1,
        },
        "chat": [json.loads(r["data"]) for r in reversed(chat_rows)],
        "spell_shapes": {},
    }
    return True


def db_save_character(code, player_uuid, character_id, parsed):
    with get_db() as conn:
        conn.execute("""
            INSERT OR REPLACE INTO player_characters
                (session_code, player_uuid, character_id, character_data)
            VALUES (?, ?, ?, ?)
        """, (code, player_uuid, character_id, json.dumps(parsed)))


def db_load_characters_for_player(code, player_uuid):
    """Return all characters loaded by a specific player in this session."""
    conn = get_db()
    rows = conn.execute(
        "SELECT character_id, character_data FROM player_characters WHERE session_code = ? AND player_uuid = ?",
        (code, player_uuid),
    ).fetchall()
    return [
        {"character_id": row["character_id"], "character": json.loads(row["character_data"])}
        for row in rows
    ]


def db_load_all_characters(code):
    """Return all party characters for a session with player_uuid and character_id."""
    conn = get_db()
    rows = conn.execute(
        "SELECT player_uuid, character_id, character_data FROM player_characters WHERE session_code = ?",
        (code,)
    ).fetchall()
    return [
        {
            "player_uuid": row["player_uuid"],
            "character_id": row["character_id"],
            "character": json.loads(row["character_data"]),
        }
        for row in rows
    ]


def ensure_session_loaded(code):
    """Return True if the session is available (memory or DB)."""
    if code in sessions:
        return True
    return db_load_session(code)


# --- Helpers ---

def gen_code(length=6):
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=length))


def make_token(name, x=0, y=0, hp=10, max_hp=10, color="#e74c3c",
               is_player=False, player_id=None, image_url=None, size=1):
    return {
        "id": str(uuid.uuid4())[:8],
        "name": name,
        "x": x, "y": y,
        "hp": hp, "max_hp": max_hp,
        "color": color,
        "is_player": is_player,
        "player_id": player_id,
        "initiative": 0,
        "conditions": [],
        "image_url": image_url,
        "size": size,
        "hidden": False,
    }


# --- Routes ---

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/create", methods=["POST"])
def create_session():
    dm_name = request.form.get("name", "DM").strip() or "DM"
    code = gen_code()
    while db_session_exists(code):
        code = gen_code()

    sessions[code] = {
        "dm_name": dm_name,
        "dm_socket": None,
        "players": {},
        "tokens": {},
        "initiative_order": [],
        "current_turn": -1,
        "map": {"cols": 20, "rows": 15, "grid_size": 50, "image_url": None, "offset_x": 0, "offset_y": 0, "scale_x": 1, "scale_y": 1},
        "chat": [],
        "spell_shapes": {},
    }
    db_save_session(code)

    session["code"] = code
    session["role"] = "dm"
    session["name"] = dm_name
    return redirect(url_for("vtt", code=code))


@app.route("/join", methods=["POST"])
def join_session():
    code = request.form.get("code", "").strip().upper()
    name = request.form.get("name", "Player").strip() or "Player"
    if not ensure_session_loaded(code):
        return render_template("index.html", error="Session not found.")
    session["code"] = code
    session["role"] = "player"
    session["name"] = name
    # Stable identity for this player across reconnects/reloads
    if "player_uuid" not in session:
        session["player_uuid"] = str(uuid.uuid4())
    return redirect(url_for("vtt", code=code))


@app.route("/session/<code>")
def vtt(code):
    if not ensure_session_loaded(code) or "role" not in session:
        return redirect(url_for("index"))
    if session.get("role") == "player" and "player_uuid" not in session:
        session["player_uuid"] = str(uuid.uuid4())
    return render_template("session.html",
                           code=code,
                           role=session["role"],
                           name=session["name"])


@app.route("/session/<code>/upload_map", methods=["POST"])
def upload_map(code):
    if session.get("role") != "dm" or session.get("code") != code:
        return {"error": "Forbidden"}, 403
    if not ensure_session_loaded(code):
        return {"error": "Session not found"}, 404
    file = request.files.get("file")
    if not file or not file.filename:
        return {"error": "No file provided"}, 400
    ext = file.filename.rsplit(".", 1)[-1].lower() if "." in file.filename else ""
    if ext not in ALLOWED_IMAGE_EXTENSIONS:
        return {"error": "Invalid file type"}, 400
    os.makedirs(UPLOAD_FOLDER, exist_ok=True)
    filename = f"{code}_map.{ext}"
    file.save(os.path.join(UPLOAD_FOLDER, filename))
    url = f"/static/uploads/{filename}"
    sess = sessions[code]
    sess["map"]["image_url"] = url
    sess["map"]["offset_x"] = 0
    sess["map"]["offset_y"] = 0
    sess["map"]["scale_x"] = 1
    sess["map"]["scale_y"] = 1
    db_save_session(code)
    socketio.emit("map_image_updated", {"url": url, "offset_x": 0, "offset_y": 0, "scale_x": 1, "scale_y": 1}, room=code)
    return {"url": url}


# --- Socket events ---

@socketio.on("connect")
def on_connect():
    code = session.get("code")
    role = session.get("role")
    name = session.get("name", "Unknown")
    if not code or not ensure_session_loaded(code):
        return False

    player_uuid = session.get("player_uuid") or (str(uuid.uuid4()) if role == "player" else None)
    join_room(code)
    socket_info[request.sid] = {"code": code, "role": role, "name": name, "player_uuid": player_uuid}
    sess = sessions[code]

    if role == "dm":
        sess["dm_socket"] = request.sid
    else:
        sess["players"][request.sid] = {
            "name": name,
            "player_uuid": player_uuid,
            "characters": {},  # character_id -> {dicecloud_token, character_data}
        }

    # Build party characters list for DM
    party_chars = []
    if role == "dm":
        party_chars = db_load_all_characters(code)
        uuid_to_sid = {
            info["player_uuid"]: sid
            for sid, info in socket_info.items()
            if info.get("player_uuid") and info["code"] == code
        }
        for entry in party_chars:
            entry["player_sid"] = uuid_to_sid.get(entry["player_uuid"])

    visible_tokens = list(sess["tokens"].values()) if role == "dm" else \
                     [t for t in sess["tokens"].values() if not t.get("hidden")]
    emit("session_state", {
        "role": role,
        "tokens": visible_tokens,
        "initiative_order": sess["initiative_order"],
        "current_turn": sess["current_turn"],
        "map": sess["map"],
        "players": {sid: {"name": p["name"], "uuid": p.get("player_uuid")} for sid, p in sess["players"].items()},
        "chat": sess["chat"][-50:],
        "my_sid": request.sid,
        "my_uuid": player_uuid,
        "party_characters": party_chars,
        "spell_shapes": list(sess.get("spell_shapes", {}).values()),
    })
    emit("player_joined", {"name": name, "role": role, "sid": request.sid, "uuid": player_uuid},
         room=code, include_self=False)

    # Restore all character sheets for returning players; notify DM of each
    if role == "player" and player_uuid:
        chars = db_load_characters_for_player(code, player_uuid)
        player = sess["players"][request.sid]
        dm_socket = sess.get("dm_socket")
        for entry in chars:
            char_id = entry["character_id"]
            char_data = entry["character"]
            player["characters"][char_id] = {"dicecloud_token": None, "character_data": char_data}
            emit("character_loaded", {"character_id": char_id, "character": char_data})
            if dm_socket:
                emit("character_shared", {
                    "player_uuid": player_uuid,
                    "player_sid": request.sid,
                    "character_id": char_id,
                    "character": char_data,
                }, room=dm_socket)


@socketio.on("disconnect")
def on_disconnect():
    info = socket_info.pop(request.sid, None)
    if not info:
        return
    code = info["code"]
    if code not in sessions:
        return
    sess = sessions[code]
    sess["players"].pop(request.sid, None)
    emit("player_left", {"name": info["name"], "sid": request.sid}, room=code)


# Token management (DM only)

def _resolve_player_id(raw, sess):
    """Convert a socket SID to a stable player UUID if possible; pass UUIDs through as-is."""
    if not raw:
        return None
    if raw in sess["players"]:
        # Client sent a socket SID — convert to stable UUID
        return sess["players"][raw].get("player_uuid") or raw
    # Client already sent a UUID (e.g. from the party spawn button)
    return raw


@socketio.on("add_token")
def on_add_token(data):
    info = socket_info.get(request.sid)
    if not info or info["role"] != "dm":
        return
    code = info["code"]
    sess = sessions[code]
    token = make_token(
        name=data.get("name", "Token"),
        x=int(data.get("x", 0)),
        y=int(data.get("y", 0)),
        hp=int(data.get("hp", 10)),
        max_hp=int(data.get("max_hp", 10)),
        color=data.get("color", "#e74c3c"),
        is_player=bool(data.get("is_player", False)),
        player_id=_resolve_player_id(data.get("player_id"), sess),
        image_url=data.get("image_url") or None,
        size=max(1, min(4, int(data.get("size", 1)))),
    )
    sess["tokens"][token["id"]] = token
    db_upsert_token(token, code)
    emit("token_added", token, room=code)


@socketio.on("remove_token")
def on_remove_token(data):
    info = socket_info.get(request.sid)
    if not info or info["role"] != "dm":
        return
    code = info["code"]
    sess = sessions[code]
    tid = data.get("id")
    if tid in sess["tokens"]:
        sess["tokens"].pop(tid)
        if tid in sess["initiative_order"]:
            sess["initiative_order"].remove(tid)
            db_save_session(code)
        db_delete_token(tid)
        emit("token_removed", {"id": tid}, room=code)


@socketio.on("move_token")
def on_move_token(data):
    info = socket_info.get(request.sid)
    if not info:
        return
    code = info["code"]
    sess = sessions[code]
    tid = data.get("id")
    if tid not in sess["tokens"]:
        return
    token = sess["tokens"][tid]
    if info["role"] != "dm" and token.get("player_id") != info.get("player_uuid"):
        return
    token["x"] = int(data.get("x", token["x"]))
    token["y"] = int(data.get("y", token["y"]))
    db_upsert_token(token, code)
    emit("token_moved", {"id": tid, "x": token["x"], "y": token["y"]}, room=code)


@socketio.on("update_hp")
def on_update_hp(data):
    info = socket_info.get(request.sid)
    if not info:
        return
    code = info["code"]
    sess = sessions[code]
    tid = data.get("id")
    if tid not in sess["tokens"]:
        return
    token = sess["tokens"][tid]
    if info["role"] != "dm" and token.get("player_id") != info.get("player_uuid"):
        return
    new_hp = max(0, min(int(data.get("hp", token["hp"])), token["max_hp"]))
    token["hp"] = new_hp
    db_upsert_token(token, code)
    emit("hp_updated", {"id": tid, "hp": new_hp, "max_hp": token["max_hp"]}, room=code)


@socketio.on("update_token")
def on_update_token(data):
    info = socket_info.get(request.sid)
    if not info:
        return
    code = info["code"]
    sess = sessions[code]
    tid = data.get("id")
    if tid not in sess["tokens"]:
        return
    token = sess["tokens"][tid]
    # Players can only edit their own token
    if info["role"] != "dm" and token.get("player_id") != info.get("player_uuid"):
        return
    if "name" in data:
        token["name"] = str(data["name"])[:50] or token["name"]
    if "color" in data:
        token["color"] = str(data["color"])
    if "image_url" in data:
        token["image_url"] = data["image_url"] or None
    if "size" in data:
        token["size"] = max(1, min(4, int(data["size"])))
    if "hp" in data:
        token["hp"] = max(0, int(data["hp"]))
    if "max_hp" in data:
        token["max_hp"] = max(1, int(data["max_hp"]))
        token["hp"] = min(token["hp"], token["max_hp"])
    if "conditions" in data:
        raw = data["conditions"]
        if isinstance(raw, list):
            allowed = {
                "blinded","burning","charmed","deafened","exhaustion","frightened","grappled",
                "incapacitated","invisible","paralyzed","petrified","poisoned",
                "prone","restrained","stunned","unconscious",
            }
            cleaned = [c for c in raw if isinstance(c, str) and c in allowed]
            exh = min(cleaned.count("exhaustion"), 6)
            token["conditions"] = [c for c in cleaned if c != "exhaustion"] + ["exhaustion"] * exh
    if info["role"] == "dm":
        if "is_player" in data:
            token["is_player"] = bool(data["is_player"])
        if "player_id" in data:
            token["player_id"] = _resolve_player_id(data["player_id"], sess)
        if "hidden" in data:
            token["hidden"] = bool(data["hidden"])
    db_upsert_token(token, code)
    emit("token_updated", token, room=code)


@socketio.on("update_token_initiative")
def on_update_initiative(data):
    info = socket_info.get(request.sid)
    if not info or info["role"] != "dm":
        return
    code = info["code"]
    sess = sessions[code]
    tid = data.get("id")
    if tid not in sess["tokens"]:
        return
    sess["tokens"][tid]["initiative"] = int(data.get("initiative", 0))
    db_upsert_token(sess["tokens"][tid], code)
    emit("token_initiative_updated",
         {"id": tid, "initiative": sess["tokens"][tid]["initiative"]},
         room=code)


@socketio.on("start_combat")
def on_start_combat(data=None):
    info = socket_info.get(request.sid)
    if not info or info["role"] != "dm":
        return
    code = info["code"]
    sess = sessions[code]
    if data and "initiatives" in data:
        for tid, initiative in data["initiatives"].items():
            if tid in sess["tokens"]:
                sess["tokens"][tid]["initiative"] = int(initiative)
                db_upsert_token(sess["tokens"][tid], code)
    ordered = sorted(
        sess["tokens"].keys(),
        key=lambda tid: sess["tokens"][tid]["initiative"],
        reverse=True,
    )
    sess["initiative_order"] = ordered
    sess["current_turn"] = 0 if ordered else -1
    db_save_session(code)
    emit("combat_started", {
        "order": ordered,
        "current_turn": sess["current_turn"],
        "tokens": list(sess["tokens"].values()),
    }, room=code)


@socketio.on("next_turn")
def on_next_turn():
    info = socket_info.get(request.sid)
    if not info or info["role"] != "dm":
        return
    code = info["code"]
    sess = sessions[code]
    if not sess["initiative_order"]:
        return
    sess["current_turn"] = (sess["current_turn"] + 1) % len(sess["initiative_order"])
    db_save_session(code)
    emit("turn_changed", {"current_turn": sess["current_turn"]}, room=code)


@socketio.on("end_combat")
def on_end_combat():
    info = socket_info.get(request.sid)
    if not info or info["role"] != "dm":
        return
    code = info["code"]
    sess = sessions[code]
    sess["initiative_order"] = []
    sess["current_turn"] = -1
    db_save_session(code)
    emit("combat_ended", {}, room=code)


@socketio.on("resize_map")
def on_resize_map(data):
    info = socket_info.get(request.sid)
    if not info or info["role"] != "dm":
        return
    cols = max(5, min(50, int(data.get("cols", 20))))
    rows = max(5, min(50, int(data.get("rows", 15))))
    code = info["code"]
    sess = sessions[code]
    sess["map"]["cols"] = cols
    sess["map"]["rows"] = rows
    db_save_session(code)
    emit("map_resized", {"cols": cols, "rows": rows}, room=code)


@socketio.on("set_map_offset")
def on_set_map_offset(data):
    info = socket_info.get(request.sid)
    if not info or info["role"] != "dm":
        return
    code = info["code"]
    sess = sessions[code]
    if not sess["map"].get("image_url"):
        return
    sess["map"]["offset_x"] = float(data.get("offset_x", 0))
    sess["map"]["offset_y"] = float(data.get("offset_y", 0))
    sess["map"]["scale_x"] = max(0.05, min(10, float(data.get("scale_x", sess["map"].get("scale_x", 1)))))
    sess["map"]["scale_y"] = max(0.05, min(10, float(data.get("scale_y", sess["map"].get("scale_y", 1)))))
    db_save_session(code)
    emit("map_image_updated", {
        "url": sess["map"]["image_url"],
        "offset_x": sess["map"]["offset_x"],
        "offset_y": sess["map"]["offset_y"],
        "scale_x": sess["map"]["scale_x"],
        "scale_y": sess["map"]["scale_y"],
    }, room=code)


@socketio.on("clear_map_image")
def on_clear_map_image():
    info = socket_info.get(request.sid)
    if not info or info["role"] != "dm":
        return
    code = info["code"]
    sess = sessions[code]
    sess["map"]["image_url"] = None
    sess["map"]["offset_x"] = 0
    sess["map"]["offset_y"] = 0
    sess["map"]["scale_x"] = 1
    sess["map"]["scale_y"] = 1
    db_save_session(code)
    emit("map_image_updated", {"url": None, "offset_x": 0, "offset_y": 0, "scale_x": 1, "scale_y": 1}, room=code)


# Dice roller

@socketio.on("ping")
def on_ping(data):
    info = socket_info.get(request.sid)
    if not info:
        return
    emit("ping", {"x": data.get("x", 0), "y": data.get("y", 0)}, room=info["code"])


# Spell shape overlays (DM only; broadcast to all clients in room)

@socketio.on("add_spell_shape")
def on_add_spell_shape(data):
    info = socket_info.get(request.sid)
    if not info:
        return
    code = info["code"]
    sess = sessions.get(code)
    if not sess:
        return
    if "spell_shapes" not in sess:
        sess["spell_shapes"] = {}
    shape_id = data.get("id") or str(uuid.uuid4())[:8]
    shape = {**data, "id": shape_id}
    sess["spell_shapes"][shape_id] = shape
    emit("spell_shape_added", shape, room=code)


@socketio.on("update_spell_shape")
def on_update_spell_shape(data):
    info = socket_info.get(request.sid)
    if not info:
        return
    code = info["code"]
    sess = sessions.get(code)
    if not sess:
        return
    shape_id = data.get("id")
    if shape_id and shape_id in sess.get("spell_shapes", {}):
        sess["spell_shapes"][shape_id] = {**data}
        emit("spell_shape_added", data, room=code)  # reuse upsert event on clients


@socketio.on("remove_spell_shape")
def on_remove_spell_shape(data):
    info = socket_info.get(request.sid)
    if not info:
        return
    code = info["code"]
    sess = sessions.get(code)
    if not sess:
        return
    shape_id = data.get("id")
    if shape_id:
        sess.get("spell_shapes", {}).pop(shape_id, None)
    emit("spell_shape_removed", {"id": shape_id}, room=code)


@socketio.on("clear_spell_shapes")
def on_clear_spell_shapes(data=None):
    info = socket_info.get(request.sid)
    if not info or info["role"] != "dm":
        return
    code = info["code"]
    sess = sessions.get(code)
    if not sess:
        return
    sess["spell_shapes"] = {}
    emit("spell_shapes_cleared", {}, room=code)


@socketio.on("roll_dice")
def on_roll_dice(data):
    info = socket_info.get(request.sid)
    if not info:
        return
    result = roll(data.get("notation", "1d20"))
    if result is None:
        emit("error_msg", {"message": "Invalid dice notation."})
        return
    msg = {
        "name": info["name"],
        "notation": data.get("notation", "1d20"),
        "result": result["total"],
        "rolls": result["rolls"],
        "modifier": result["modifier"],
        "type": "dice",
    }
    code = info["code"]
    sessions[code]["chat"].append(msg)
    db_append_chat(msg, code)
    emit("chat_entry", msg, room=code)


# Chat

@socketio.on("chat_message")
def on_chat(data):
    info = socket_info.get(request.sid)
    if not info:
        return
    msg = {
        "name": info["name"],
        "text": str(data.get("text", ""))[:500],
        "type": "chat",
    }
    code = info["code"]
    sessions[code]["chat"].append(msg)
    db_append_chat(msg, code)
    emit("chat_entry", msg, room=code)


# DiceCloud login + character load

@socketio.on("dicecloud_login")
def on_dicecloud_login(data):
    info = socket_info.get(request.sid)
    if not info:
        return

    username = data.get("username", "")
    password = data.get("password", "")
    character_id = data.get("character_id", "").strip()

    try:
        resp = requests.post(
            f"{DICECLOUD_BASE}/login",
            json={"username": username, "password": password},
            timeout=10,
        )
        resp.raise_for_status()
        token = resp.json()["token"]

        char_resp = requests.get(
            f"{DICECLOUD_BASE}/creature/{character_id}",
            headers={"Authorization": f"Bearer {token}"},
            timeout=15,
        )
        char_resp.raise_for_status()
        parsed = parse_character(char_resp.json(), character_id)

        code = info["code"]
        sess = sessions[code]
        if request.sid in sess["players"]:
            sess["players"][request.sid]["characters"][character_id] = {
                "dicecloud_token": token,
                "character_data": parsed,
            }

        parsed["player_name"] = info["name"]
        emit("character_loaded", {"character_id": character_id, "character": parsed})

        player_uuid = info.get("player_uuid")
        if player_uuid:
            db_save_character(code, player_uuid, character_id, parsed)
            dm_socket = sess.get("dm_socket")
            if dm_socket:
                emit("character_shared", {
                    "player_uuid": player_uuid,
                    "player_sid": request.sid,
                    "character_id": character_id,
                    "character": parsed,
                }, room=dm_socket)

        # Sync HP to the matching named token if one exists
        for t in sess["tokens"].values():
            if t.get("player_id") == player_uuid and t.get("name", "").lower() == parsed["name"].lower():
                t["max_hp"] = parsed["hp"]["max"]
                t["hp"] = min(t["hp"], parsed["hp"]["max"])
                db_upsert_token(t, code)
                emit("token_updated", t, room=code)
                break

    except requests.HTTPError as e:
        emit("dicecloud_error", {"message": f"Dicecloud error: {e.response.status_code}"})
    except Exception as e:
        emit("dicecloud_error", {"message": str(e)})


@socketio.on("refresh_character")
def on_refresh_character(data=None):
    info = socket_info.get(request.sid)
    if not info or info["role"] != "player":
        return
    code = info["code"]
    sess = sessions[code]
    player = sess["players"].get(request.sid, {})

    character_id = (data or {}).get("character_id")
    char_entry = player.get("characters", {}).get(character_id) if character_id else None
    if not char_entry:
        emit("dicecloud_error", {"message": "No character loaded yet — use the login form first."})
        return
    dc_token = char_entry.get("dicecloud_token")
    if not dc_token:
        emit("dicecloud_error", {"message": "DiceCloud session expired — please re-enter your credentials."})
        return

    try:
        char_resp = requests.get(
            f"{DICECLOUD_BASE}/creature/{character_id}",
            headers={"Authorization": f"Bearer {dc_token}"},
            timeout=15,
        )
        char_resp.raise_for_status()
        parsed = parse_character(char_resp.json(), character_id)

        char_entry["character_data"] = parsed
        parsed["player_name"] = info["name"]
        emit("character_loaded", {"character_id": character_id, "character": parsed})

        player_uuid = info.get("player_uuid")
        if player_uuid:
            db_save_character(code, player_uuid, character_id, parsed)
            dm_socket = sess.get("dm_socket")
            if dm_socket:
                emit("character_shared", {
                    "player_uuid": player_uuid,
                    "player_sid": request.sid,
                    "character_id": character_id,
                    "character": parsed,
                }, room=dm_socket)

        for t in sess["tokens"].values():
            if t.get("player_id") == player_uuid and t.get("name", "").lower() == parsed["name"].lower():
                t["max_hp"] = parsed["hp"]["max"]
                t["hp"] = min(t["hp"], parsed["hp"]["max"])
                db_upsert_token(t, code)
                emit("token_updated", t, room=code)
                break

    except requests.HTTPError as e:
        if e.response.status_code in (401, 403):
            emit("dicecloud_error", {"message": "DiceCloud session expired — please re-enter your credentials."})
        else:
            emit("dicecloud_error", {"message": f"DiceCloud error: {e.response.status_code}"})
    except Exception as e:
        emit("dicecloud_error", {"message": str(e)})


# --- Helpers ---

def parse_character(data, character_id):
    creature = data.get("creatures", [{}])[0]
    variables = (data.get("creatureVariables") or [{}])[0]
    properties = data.get("creatureProperties", [])

    hp_var = variables.get("hitPoints", {})
    temp_hp_var = variables.get("tempHP", {})

    abilities = {}
    for ab in ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"]:
        v = variables.get(ab, {})
        abilities[ab] = {
            "score": v.get("total", v.get("value", 10)),
            "modifier": v.get("modifier", 0),
        }

    skills = {}
    for sk in ["athletics", "acrobatics", "sleightOfHand", "stealth",
               "arcana", "history", "investigation", "nature", "religion",
               "animalHandling", "insight", "medicine", "perception", "survival",
               "deception", "intimidation", "performance", "persuasion"]:
        v = variables.get(sk, {})
        if v:
            skills[sk] = {"value": v.get("value", 0), "proficiency": v.get("proficiency", 0)}

    saves = {}
    for ab in ["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma"]:
        v = variables.get(f"{ab}Save", {})
        if v:
            saves[ab] = {"value": v.get("value", 0), "proficiency": v.get("proficiency", 0)}

    ac_var = variables.get("armor") or variables.get("ac") or variables.get("armorClass") or {}
    speed_var = variables.get("speed") or {}

    resources = []
    spell_slots = []
    conditions = []
    class_level_totals = {}

    for prop in properties:
        if prop.get("removed") or prop.get("inactive"):
            continue
        ptype = prop.get("type")
        atype = prop.get("attributeType")

        if ptype == "attribute" and atype == "resource":
            resources.append({
                "name": prop.get("name", ""),
                "value": prop.get("value", 0),
                "total": prop.get("total", 0),
                "variableName": prop.get("variableName", ""),
            })
        elif (ptype == "attribute" and atype == "spellSlot"
              and prop.get("variableName", "").lower().startswith("spell")):
            spell_slots.append({
                "name": prop.get("name", ""),
                "value": prop.get("value", 0),
                "total": prop.get("total", 0),
                "variableName": prop.get("variableName", ""),
            })
        elif ptype == "buff":
            conditions.append(prop.get("name", ""))
        elif ptype == "classLevel":
            class_name = prop.get("name", "Unknown")
            gained = prop.get("level") or prop.get("value") or 1
            class_level_totals[class_name] = max(class_level_totals.get(class_name, 0), gained)

    class_levels = [{"name": name, "level": level} for name, level in class_level_totals.items()]

    return {
        "id": character_id,
        "name": creature.get("name", "Unknown"),
        "avatar": creature.get("avatarPicture"),
        "hp": {
            "current": hp_var.get("value", 0),
            "max": hp_var.get("total", 0),
            "temp": temp_hp_var.get("value", 0),
        },
        "ac": ac_var.get("value") or ac_var.get("total") or 10,
        "speed": speed_var.get("value") or speed_var.get("total") or 30,
        "initiative_bonus": variables.get("initiative", {}).get("value", 0),
        "abilities": abilities,
        "skills": skills,
        "saves": saves,
        "resources": resources,
        "spell_slots": spell_slots,
        "conditions": conditions,
        "class_levels": class_levels,
        "proficiency_bonus": variables.get("proficiencyBonus", {}).get("value", 2),
        "death_saves": creature.get("deathSave", {}),
    }


def roll(notation):
    notation = notation.strip().lower().replace(" ", "")
    m = re.match(r"^(\d*)d(\d+)([+-]\d+)?$", notation)
    if not m:
        try:
            v = int(notation)
            return {"total": v, "rolls": [v], "modifier": 0}
        except ValueError:
            return None
    count = int(m.group(1)) if m.group(1) else 1
    sides = int(m.group(2))
    modifier = int(m.group(3)) if m.group(3) else 0
    if count > 100 or sides > 1000 or count < 1:
        return None
    rolls = [random.randint(1, sides) for _ in range(count)]
    return {"total": sum(rolls) + modifier, "rolls": rolls, "modifier": modifier}


init_db()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host="0.0.0.0", port=port, debug=True)
