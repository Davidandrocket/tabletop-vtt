from gevent import monkey
monkey.patch_all()

import os
import json
import uuid
import time
import secrets
import random
import string
import re
import shutil
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
_role_tokens = {}   # token -> {code, role, name, expires}


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
            ("image_url",      "TEXT"),
            ("size",           "INTEGER DEFAULT 1"),
            ("hidden",         "INTEGER DEFAULT 0"),
            ("show_hp",        "INTEGER DEFAULT 1"),
            ("initiative_mod", "INTEGER DEFAULT 0"),
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
            ("active_profile_id","INTEGER"),
            ("fog",              "TEXT DEFAULT '[]'"),
        ]:
            try:
                conn.execute(f"ALTER TABLE sessions ADD COLUMN {col} {defn}")
            except sqlite3.OperationalError:
                pass  # already exists

        conn.execute("""
            CREATE TABLE IF NOT EXISTS map_profiles (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                session_code TEXT NOT NULL,
                name         TEXT NOT NULL,
                image_url    TEXT,
                offset_x     REAL DEFAULT 0,
                offset_y     REAL DEFAULT 0,
                scale_x      REAL DEFAULT 1,
                scale_y      REAL DEFAULT 1,
                cols         INTEGER DEFAULT 20,
                rows         INTEGER DEFAULT 15
            )
        """)

        for col, defn in [
            ("fog", "TEXT DEFAULT '[]'"),
        ]:
            try:
                conn.execute(f"ALTER TABLE map_profiles ADD COLUMN {col} {defn}")
            except sqlite3.OperationalError:
                pass

        conn.execute("""
            CREATE TABLE IF NOT EXISTS token_library (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                name           TEXT    NOT NULL,
                max_hp         INTEGER DEFAULT 10,
                color          TEXT    DEFAULT '#e74c3c',
                image_url      TEXT,
                size           INTEGER DEFAULT 1,
                initiative_mod INTEGER DEFAULT 0,
                show_hp        INTEGER DEFAULT 1
            )
        """)

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
    fog_list = [list(c) for c in sess.get("fog", set())]
    with get_db() as conn:
        conn.execute("""
            INSERT OR REPLACE INTO sessions
                (code, dm_name, map_cols, map_rows, initiative_order, current_turn,
                 map_image_url, map_offset_x, map_offset_y, map_image_scale, map_image_scale_y,
                 active_profile_id, fog)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            sess.get("active_profile_id"),
            json.dumps(fog_list),
        ))


def db_upsert_token(token, code):
    with get_db() as conn:
        conn.execute("""
            INSERT OR REPLACE INTO tokens
                (id, session_code, name, x, y, hp, max_hp,
                 color, is_player, player_id, initiative, conditions,
                 image_url, size, hidden, show_hp, initiative_mod)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            1 if token.get("show_hp", True) else 0,
            token.get("initiative_mod", 0),
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
        token["is_player"]     = bool(token["is_player"])
        token["hidden"]        = bool(token.get("hidden", 0))
        token["show_hp"]       = bool(token.get("show_hp", 1))
        token["initiative_mod"] = int(token.get("initiative_mod") or 0)
        token["conditions"]    = json.loads(token.get("conditions") or "[]")
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
        "active_profile_id": row["active_profile_id"],
        "fog": {(int(c[0]), int(c[1])) for c in json.loads(row["fog"] or "[]")},
    }
    return True


def db_load_library():
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM token_library ORDER BY name COLLATE NOCASE"
        ).fetchall()
    return [dict(r) for r in rows]


def db_load_profiles(code):
    with get_db() as conn:
        rows = conn.execute(
            "SELECT * FROM map_profiles WHERE session_code = ? ORDER BY id",
            (code,)
        ).fetchall()
    return [dict(r) for r in rows]


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
               is_player=False, player_id=None, image_url=None, size=1,
               show_hp=None, initiative_mod=0):
    return {
        "id": str(uuid.uuid4())[:8],
        "name": name,
        "x": x, "y": y,
        "hp": hp, "max_hp": max_hp,
        "color": color,
        "is_player": is_player,
        "player_id": player_id,
        "initiative": 0,
        "initiative_mod": initiative_mod,
        "conditions": [],
        "image_url": image_url,
        "size": size,
        "hidden": False,
        # Player tokens show HP by default; NPC tokens hide it
        "show_hp": is_player if show_hp is None else bool(show_hp),
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
        "active_profile_id": None,
        "fog": set(),
    }
    db_save_session(code)

    session.setdefault("sessions", {})[code] = {"role": "dm", "name": dm_name}
    return redirect(url_for("vtt", code=code))


@app.route("/join", methods=["POST"])
def join_session():
    code = request.form.get("code", "").strip().upper()
    name = request.form.get("name", "Player").strip() or "Player"
    if not ensure_session_loaded(code):
        return render_template("index.html", error="Session not found.")
    sessions_map = session.setdefault("sessions", {})
    # Preserve player_uuid per session for stable identity across reconnects
    existing = sessions_map.get(code, {})
    player_uuid = existing.get("player_uuid") or str(uuid.uuid4())
    sessions_map[code] = {"role": "player", "name": name, "player_uuid": player_uuid}
    session.modified = True
    return redirect(url_for("vtt", code=code))


@app.route("/session/<code>")
def vtt(code):
    if not ensure_session_loaded(code):
        return redirect(url_for("index"))
    sess_entry = session.get("sessions", {}).get(code)
    if not sess_entry:
        return redirect(url_for("index"))
    return render_template("session.html",
                           code=code,
                           role=sess_entry["role"],
                           name=sess_entry["name"])


@app.route("/session/<code>/accept_role")
def accept_role(code):
    """One-time endpoint for DM transfers — updates Flask session role and redirects."""
    token = request.args.get("token", "")
    pending = _role_tokens.pop(token, None)
    if not pending or pending["code"] != code or time.time() > pending["expires"]:
        return "Invalid or expired link", 400
    new_role = pending["role"]
    new_name = pending["name"]
    sessions_map = session.setdefault("sessions", {})
    existing = sessions_map.get(code, {})
    player_uuid = existing.get("player_uuid") or (str(uuid.uuid4()) if new_role == "player" else None)
    sessions_map[code] = {"role": new_role, "name": new_name, "player_uuid": player_uuid}
    session.modified = True
    return redirect(url_for("vtt", code=code))


@app.route("/session/<code>/upload_map", methods=["POST"])
def upload_map(code):
    sess_entry = session.get("sessions", {}).get(code, {})
    if sess_entry.get("role") != "dm":
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
    code = request.args.get("code", "").strip().upper()
    sess_entry = session.get("sessions", {}).get(code)
    if not sess_entry or not ensure_session_loaded(code):
        return False
    role = sess_entry["role"]
    name = sess_entry.get("name", "Unknown")
    player_uuid = sess_entry.get("player_uuid") or (str(uuid.uuid4()) if role == "player" else None)
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
        "map_profiles": db_load_profiles(code),
        "active_profile_id": sess.get("active_profile_id"),
        "fog": [list(c) for c in sess.get("fog", set())],
        "token_library": db_load_library() if role == "dm" else [],
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
    if sess.get("dm_socket") == request.sid:
        sess["dm_socket"] = None
    emit("player_left", {"name": info["name"], "sid": request.sid}, room=code)


@socketio.on("transfer_dm")
def on_transfer_dm(data):
    info = socket_info.get(request.sid)
    if not info or info["role"] != "dm":
        return
    code = info["code"]
    sess = sessions[code]
    target_sid = data.get("target_sid")
    if not target_sid or target_sid not in sess["players"]:
        return

    target_info = socket_info.get(target_sid)
    if not target_info or target_info["code"] != code:
        return

    old_dm_sid = request.sid
    old_dm_name = info["name"]
    new_dm_name = target_info["name"]

    # Swap roles in socket_info
    info["role"] = "player"
    target_info["role"] = "dm"

    # Old DM becomes a player entry
    old_dm_uuid = str(uuid.uuid4())
    info["player_uuid"] = old_dm_uuid
    sess["players"][old_dm_sid] = {
        "name": old_dm_name,
        "player_uuid": old_dm_uuid,
        "characters": {},
    }

    # New DM removed from players, becomes dm_socket
    sess["players"].pop(target_sid, None)
    sess["dm_socket"] = target_sid

    # One-time tokens so each party can update their Flask session cookie
    expires = time.time() + 60
    promo_token = secrets.token_urlsafe(16)
    demo_token = secrets.token_urlsafe(16)
    _role_tokens[promo_token] = {"code": code, "role": "dm",     "name": new_dm_name, "expires": expires}
    _role_tokens[demo_token]  = {"code": code, "role": "player", "name": old_dm_name, "expires": expires}

    # Notify everyone — each client uses their SID to determine which token applies
    emit("dm_transferred", {
        "new_dm_sid":    target_sid,
        "old_dm_sid":    old_dm_sid,
        "new_dm_name":   new_dm_name,
        "old_dm_name":   old_dm_name,
        "promo_token":   promo_token,   # new DM uses this
        "demo_token":    demo_token,    # old DM uses this
    }, room=code)


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
        show_hp=bool(data["show_hp"]) if "show_hp" in data else None,
        initiative_mod=int(data.get("initiative_mod", 0)),
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
        if "show_hp" in data:
            token["show_hp"] = bool(data["show_hp"])
        if "initiative_mod" in data:
            token["initiative_mod"] = int(data["initiative_mod"])
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
    emit("ping", {
        "x": data.get("x", 0),
        "y": data.get("y", 0),
        "color": str(data.get("color", "#4ECCA3"))[:7],
    }, room=info["code"])


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


# Map profiles (DM only)

@socketio.on("save_map_profile")
def on_save_map_profile(data):
    info = socket_info.get(request.sid)
    if not info or info["role"] != "dm":
        return
    code = info["code"]
    sess = sessions.get(code)
    if not sess:
        return
    name = str(data.get("name", "Profile")).strip()[:50] or "Profile"
    current_map = sess["map"]
    image_url = current_map.get("image_url")

    # Copy image to a stable, profile-owned file so future uploads don't overwrite it
    if image_url:
        filename = image_url.rsplit("/", 1)[-1]
        src = os.path.join(UPLOAD_FOLDER, filename)
        if os.path.exists(src):
            ext = filename.rsplit(".", 1)[-1] if "." in filename else "png"
            profile_filename = f"{code}_profile_{uuid.uuid4().hex[:8]}.{ext}"
            dst = os.path.join(UPLOAD_FOLDER, profile_filename)
            shutil.copy2(src, dst)
            image_url = f"/static/uploads/{profile_filename}"

    fog_list = [list(c) for c in sess.get("fog", set())]
    with get_db() as conn:
        cursor = conn.execute("""
            INSERT INTO map_profiles
                (session_code, name, image_url, offset_x, offset_y, scale_x, scale_y, cols, rows, fog)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            code, name, image_url,
            current_map.get("offset_x", 0), current_map.get("offset_y", 0),
            current_map.get("scale_x", 1), current_map.get("scale_y", 1),
            current_map.get("cols", 20), current_map.get("rows", 15),
            json.dumps(fog_list),
        ))
        profile_id = cursor.lastrowid

    sess["active_profile_id"] = profile_id
    db_save_session(code)
    emit("map_profiles_updated", {
        "profiles": db_load_profiles(code),
        "active_profile_id": profile_id,
    }, room=code)


@socketio.on("load_map_profile")
def on_load_map_profile(data):
    info = socket_info.get(request.sid)
    if not info or info["role"] != "dm":
        return
    code = info["code"]
    sess = sessions.get(code)
    if not sess:
        return
    profile_id = data.get("id")
    if profile_id is None:
        return
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM map_profiles WHERE id = ? AND session_code = ?",
            (int(profile_id), code)
        ).fetchone()
    if not row:
        return

    fog_raw = json.loads(row["fog"] or "[]")
    sess["map"]["image_url"] = row["image_url"]
    sess["map"]["offset_x"]  = row["offset_x"]
    sess["map"]["offset_y"]  = row["offset_y"]
    sess["map"]["scale_x"]   = row["scale_x"]
    sess["map"]["scale_y"]   = row["scale_y"]
    sess["map"]["cols"]      = row["cols"]
    sess["map"]["rows"]      = row["rows"]
    sess["active_profile_id"] = row["id"]
    sess["spell_shapes"] = {}
    sess["fog"] = {(int(c[0]), int(c[1])) for c in fog_raw}

    db_save_session(code)
    emit("map_resized", {"cols": row["cols"], "rows": row["rows"]}, room=code)
    emit("map_image_updated", {
        "url": row["image_url"],
        "offset_x": row["offset_x"],
        "offset_y": row["offset_y"],
        "scale_x": row["scale_x"],
        "scale_y": row["scale_y"],
    }, room=code)
    emit("spell_shapes_cleared", {}, room=code)
    emit("fog_updated", {"fog": fog_raw}, room=code)
    emit("map_profiles_updated", {
        "profiles": db_load_profiles(code),
        "active_profile_id": row["id"],
    }, room=code)


@socketio.on("delete_map_profile")
def on_delete_map_profile(data):
    info = socket_info.get(request.sid)
    if not info or info["role"] != "dm":
        return
    code = info["code"]
    sess = sessions.get(code)
    if not sess:
        return
    profile_id = data.get("id")
    if profile_id is None:
        return
    with get_db() as conn:
        row = conn.execute(
            "SELECT image_url FROM map_profiles WHERE id = ? AND session_code = ?",
            (int(profile_id), code)
        ).fetchone()
        if not row:
            return
        conn.execute("DELETE FROM map_profiles WHERE id = ?", (int(profile_id),))

    # Clean up the copied image file if it's a profile-owned file
    image_url = row["image_url"]
    if image_url:
        filename = image_url.rsplit("/", 1)[-1]
        if "_profile_" in filename:
            path = os.path.join(UPLOAD_FOLDER, filename)
            try:
                os.remove(path)
            except OSError:
                pass

    if sess.get("active_profile_id") == int(profile_id):
        sess["active_profile_id"] = None
        db_save_session(code)

    emit("map_profiles_updated", {
        "profiles": db_load_profiles(code),
        "active_profile_id": sess.get("active_profile_id"),
    }, room=code)


@socketio.on("rename_map_profile")
def on_rename_map_profile(data):
    info = socket_info.get(request.sid)
    if not info or info["role"] != "dm":
        return
    code = info["code"]
    profile_id = data.get("id")
    name = str(data.get("name", "")).strip()[:50]
    if not profile_id or not name:
        return
    with get_db() as conn:
        conn.execute(
            "UPDATE map_profiles SET name = ? WHERE id = ? AND session_code = ?",
            (name, int(profile_id), code)
        )
    emit("map_profiles_updated", {
        "profiles": db_load_profiles(code),
        "active_profile_id": sessions.get(code, {}).get("active_profile_id"),
    }, room=code)


# Fog of War (DM only)

@socketio.on("fog_paint")
def on_fog_paint(data):
    info = socket_info.get(request.sid)
    if not info or info["role"] != "dm":
        return
    code = info["code"]
    sess = sessions.get(code)
    if not sess:
        return
    cells = data.get("cells", [])
    mode = data.get("mode", "reveal")
    fog = sess.setdefault("fog", set())
    for cell in cells:
        if len(cell) == 2:
            key = (int(cell[0]), int(cell[1]))
            if mode == "reveal":
                fog.add(key)
            else:
                fog.discard(key)
    fog_list = [list(c) for c in fog]
    db_save_session(code)
    emit("fog_updated", {"fog": fog_list}, room=code)


@socketio.on("fog_reset")
def on_fog_reset(data):
    info = socket_info.get(request.sid)
    if not info or info["role"] != "dm":
        return
    code = info["code"]
    sess = sessions.get(code)
    if not sess:
        return
    mode = data.get("mode", "all_fogged")
    cols = sess["map"].get("cols", 20)
    rows = sess["map"].get("rows", 15)
    if mode == "all_revealed":
        sess["fog"] = {(c, r) for c in range(cols) for r in range(rows)}
    else:
        sess["fog"] = set()
    fog_list = [list(c) for c in sess["fog"]]
    db_save_session(code)
    emit("fog_updated", {"fog": fog_list}, room=code)


# Token Library (global, DM only)

@socketio.on("save_to_library")
def on_save_to_library(data):
    info = socket_info.get(request.sid)
    if not info or info["role"] != "dm":
        return
    name = str(data.get("name", "Token")).strip()[:50] or "Token"
    max_hp = max(1, int(data.get("max_hp", 10)))
    color = str(data.get("color", "#e74c3c"))[:7]
    image_url = data.get("image_url") or None
    size = max(1, min(4, int(data.get("size", 1))))
    initiative_mod = int(data.get("initiative_mod", 0))
    show_hp = bool(data.get("show_hp", True))
    with get_db() as conn:
        conn.execute("""
            INSERT INTO token_library
                (name, max_hp, color, image_url, size, initiative_mod, show_hp)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        """, (name, max_hp, color, image_url, size, initiative_mod, 1 if show_hp else 0))
    emit("library_updated", {"entries": db_load_library()})


@socketio.on("update_library_entry")
def on_update_library_entry(data):
    info = socket_info.get(request.sid)
    if not info or info["role"] != "dm":
        return
    entry_id = data.get("id")
    if entry_id is None:
        return
    name = str(data.get("name", "Token")).strip()[:50] or "Token"
    max_hp = max(1, int(data.get("max_hp", 10)))
    color = str(data.get("color", "#e74c3c"))[:7]
    image_url = data.get("image_url") or None
    size = max(1, min(4, int(data.get("size", 1))))
    initiative_mod = int(data.get("initiative_mod", 0))
    show_hp = bool(data.get("show_hp", True))
    with get_db() as conn:
        conn.execute("""
            UPDATE token_library
            SET name=?, max_hp=?, color=?, image_url=?, size=?, initiative_mod=?, show_hp=?
            WHERE id=?
        """, (name, max_hp, color, image_url, size, initiative_mod, 1 if show_hp else 0, int(entry_id)))
    emit("library_updated", {"entries": db_load_library()})


@socketio.on("delete_library_entry")
def on_delete_library_entry(data):
    info = socket_info.get(request.sid)
    if not info or info["role"] != "dm":
        return
    entry_id = data.get("id")
    if entry_id is None:
        return
    with get_db() as conn:
        conn.execute("DELETE FROM token_library WHERE id = ?", (int(entry_id),))
    emit("library_updated", {"entries": db_load_library()})


@socketio.on("spawn_library_token")
def on_spawn_library_token(data):
    info = socket_info.get(request.sid)
    if not info or info["role"] != "dm":
        return
    code = info["code"]
    sess = sessions.get(code)
    if not sess:
        return
    entry_id = data.get("library_id")
    col = max(0, int(data.get("col", 0)))
    row = max(0, int(data.get("row", 0)))
    with get_db() as conn:
        db_row = conn.execute(
            "SELECT * FROM token_library WHERE id = ?", (int(entry_id),)
        ).fetchone()
    if not db_row:
        return
    token = make_token(
        name=db_row["name"],
        x=col, y=row,
        hp=db_row["max_hp"], max_hp=db_row["max_hp"],
        color=db_row["color"],
        image_url=db_row["image_url"],
        size=db_row["size"],
        show_hp=bool(db_row["show_hp"]),
        initiative_mod=db_row["initiative_mod"],
    )
    sess["tokens"][token["id"]] = token
    db_upsert_token(token, code)
    emit("token_added", token, room=code)


@socketio.on("roll_dice")
def on_roll_dice(data):
    info = socket_info.get(request.sid)
    if not info:
        return

    notation = data.get("notation", "1d20")
    private = bool(data.get("private", False)) and info["role"] == "dm"

    # DM fake roll: "1d20(17)" forces the displayed result to 17
    forced = None
    notation_clean = notation
    if info["role"] == "dm":
        fm = re.match(r"^(.+)\((\d+)\)$", notation.replace(" ", ""))
        if fm:
            notation_clean = fm.group(1)
            forced = int(fm.group(2))

    result = roll(notation_clean)
    if result is None:
        emit("error_msg", {"message": "Invalid dice notation."})
        return

    if forced is not None:
        result["total"] = forced
        result["rolls"] = [forced]

    msg = {
        "name": info["name"],
        "notation": notation_clean,
        "result": result["total"],
        "rolls": result["rolls"],
        "modifier": result["modifier"],
        "type": "dice",
    }
    code = info["code"]
    if private:
        msg["private"] = True
        emit("chat_entry", msg)  # only to the DM who rolled
    else:
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
    ddb_id = char_entry.get("ddb_id")

    try:
        if ddb_id:
            resp = requests.get(
                f"https://character-service.dndbeyond.com/character/v5/character/{ddb_id}",
                headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
                timeout=15,
            )
            resp.raise_for_status()
            char_json = resp.json()
            if not char_json.get("success"):
                emit("dicecloud_error", {"message": "Character not found or not set to public."})
                return
            parsed = parse_dnd_beyond_character(char_json, ddb_id)
        elif dc_token:
            char_resp = requests.get(
                f"{DICECLOUD_BASE}/creature/{character_id}",
                headers={"Authorization": f"Bearer {dc_token}"},
                timeout=15,
            )
            char_resp.raise_for_status()
            parsed = parse_character(char_resp.json(), character_id)
        else:
            emit("dicecloud_error", {"message": "DiceCloud session expired — please re-enter your credentials."})
            return

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


@socketio.on("dndbeyond_import")
def on_dndbeyond_import(data):
    info = socket_info.get(request.sid)
    if not info or info["role"] != "player":
        return

    ddb_id = str(data.get("character_id", "")).strip()
    if not ddb_id or not ddb_id.isdigit():
        emit("dicecloud_error", {"message": "D&D Beyond character ID must be a number."})
        return

    char_key = f"ddb:{ddb_id}"
    try:
        resp = requests.get(
            f"https://character-service.dndbeyond.com/character/v5/character/{ddb_id}",
            headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
            timeout=15,
        )
        resp.raise_for_status()
        char_json = resp.json()

        if not char_json.get("success"):
            emit("dicecloud_error", {"message": "Character not found or not set to public."})
            return

        parsed = parse_dnd_beyond_character(char_json, ddb_id)

        code = info["code"]
        sess = sessions[code]
        if request.sid in sess["players"]:
            sess["players"][request.sid]["characters"][char_key] = {
                "dicecloud_token": None,
                "ddb_id": ddb_id,
                "character_data": parsed,
            }

        parsed["player_name"] = info["name"]
        emit("character_loaded", {"character_id": char_key, "character": parsed})

        player_uuid = info.get("player_uuid")
        if player_uuid:
            db_save_character(code, player_uuid, char_key, parsed)
            dm_socket = sess.get("dm_socket")
            if dm_socket:
                emit("character_shared", {
                    "player_uuid": player_uuid,
                    "player_sid": request.sid,
                    "character_id": char_key,
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
        if e.response.status_code == 404:
            emit("dicecloud_error", {"message": "Character not found. Make sure the character is set to public on D&D Beyond."})
        else:
            emit("dicecloud_error", {"message": f"D&D Beyond error: {e.response.status_code}"})
    except Exception as e:
        emit("dicecloud_error", {"message": str(e)})


@socketio.on("remove_character")
def on_remove_character(data):
    info = socket_info.get(request.sid)
    if not info or info["role"] != "player":
        return
    code = info["code"]
    sess = sessions.get(code)
    if not sess:
        return
    character_id = data.get("character_id")
    if not character_id:
        return
    player_uuid = info.get("player_uuid")

    # Remove from in-memory session
    if request.sid in sess["players"]:
        sess["players"][request.sid]["characters"].pop(character_id, None)

    # Remove from DB
    if player_uuid:
        with get_db() as conn:
            conn.execute(
                "DELETE FROM player_characters WHERE session_code = ? AND player_uuid = ? AND character_id = ?",
                (code, player_uuid, character_id)
            )

    emit("character_removed", {"character_id": character_id})
    dm_socket = sess.get("dm_socket")
    if dm_socket:
        emit("character_removed", {"character_id": character_id, "player_uuid": player_uuid}, room=dm_socket)


# --- Helpers ---

def parse_character(data, character_id):
    creatures = data.get("creatures", [])
    if not creatures:
        raise ValueError(f"DiceCloud returned no creature data (keys: {list(data.keys())})")
    creature = creatures[0]
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


def _ddb_all_modifiers(char):
    """Flatten all D&DBeyond modifier lists into one list (excludes item modifiers)."""
    mods = []
    for source_list in (char.get("modifiers") or {}).values():
        mods.extend(source_list or [])
    return mods


def _ddb_compute_ac(char, dex_mod, all_mods):
    """Estimate AC from equipped inventory + modifiers."""
    has_shield = False
    armor_ac = None

    for item in (char.get("inventory") or []):
        if not item.get("equipped"):
            continue
        defn = item.get("definition") or {}
        if defn.get("filterType") != "Armor":
            continue
        armor_type_str = (defn.get("type") or "").lower()
        base_ac = defn.get("armorClass") or 10
        if "shield" in armor_type_str:
            has_shield = True
        elif "heavy" in armor_type_str:
            armor_ac = base_ac
        elif "medium" in armor_type_str:
            armor_ac = base_ac + min(dex_mod, 2)
        elif "light" in armor_type_str:
            armor_ac = base_ac + dex_mod

    if armor_ac is None:
        armor_ac = 10 + dex_mod  # unarmored default

    # AC bonuses (magic items, spells, etc.)
    ac_bonus = 0
    for mod in all_mods:
        if mod.get("type") == "bonus" and mod.get("subType") == "armor-class":
            ac_bonus += mod.get("value") or 0
    # Magic armor bonuses from equipped items
    for item in (char.get("inventory") or []):
        if not item.get("equipped"):
            continue
        defn = item.get("definition") or {}
        if defn.get("filterType") == "Armor":
            armor_type_str = (defn.get("type") or "").lower()
            if "shield" not in armor_type_str:
                ac_bonus += defn.get("magic") or 0

    return max(1, armor_ac + (2 if has_shield else 0) + ac_bonus)


def _ddb_compute_speed(char, all_mods):
    """Get walking speed from race data + modifiers."""
    race = char.get("race") or {}
    weight_speeds = race.get("weightSpeeds") or {}
    base_speed = (weight_speeds.get("normal") or {}).get("walk") or 30

    for mod in all_mods:
        if mod.get("type") == "set" and mod.get("subType") == "speed":
            base_speed = mod.get("value") or base_speed
    for mod in all_mods:
        if mod.get("type") == "bonus" and mod.get("subType") == "speed":
            base_speed += mod.get("value") or 0

    return base_speed


def parse_dnd_beyond_character(data, character_id):
    """Parse D&DBeyond character API (v5) response into our standard format."""
    # Top-level response wraps actual character in "data"
    char = data.get("data") or data

    name = char.get("name", "Unknown")
    avatar = (char.get("decorations") or {}).get("avatarUrl") or char.get("avatarUrl")

    # --- Modifiers (computed first — needed for stat bonuses) ---
    all_mods = _ddb_all_modifiers(char)

    # --- Stats ---
    # id: 1=STR 2=DEX 3=CON 4=INT 5=WIS 6=CHA
    # stats.value = base allocated score (before racial/feat bonuses)
    # Racial, background, and feat stat bonuses live in modifiers as
    # type="bonus", subType="{ability}-score" and must be added here.
    STAT_IDS = {1: "strength", 2: "dexterity", 3: "constitution",
                4: "intelligence", 5: "wisdom", 6: "charisma"}
    STAT_SCORE_SUBTYPES = {
        "strength-score": 1, "dexterity-score": 2, "constitution-score": 3,
        "intelligence-score": 4, "wisdom-score": 5, "charisma-score": 6,
    }

    raw      = {s["id"]: (s.get("value") or 10) for s in (char.get("stats") or [])}
    bonus_st = {s["id"]: (s.get("value") or 0)  for s in (char.get("bonusStats") or [])}
    override = {s["id"]: s.get("value")          for s in (char.get("overrideStats") or [])}

    # Sum explicitly named stat bonuses from modifiers (racial +2 DEX, etc.)
    mod_stat_bonus = {sid: 0 for sid in STAT_IDS}
    for m in all_mods:
        if m.get("type") == "bonus":
            sid = STAT_SCORE_SUBTYPES.get(m.get("subType", ""))
            if sid:
                mod_stat_bonus[sid] += m.get("value") or 0

    def get_stat(sid):
        if override.get(sid) is not None:
            return override[sid]
        return raw.get(sid, 10) + bonus_st.get(sid, 0) + mod_stat_bonus.get(sid, 0)

    def mod(score):
        return (score - 10) // 2

    abilities = {}
    for sid, ab in STAT_IDS.items():
        score = get_stat(sid)
        abilities[ab] = {"score": score, "modifier": mod(score)}

    dex_mod = abilities["dexterity"]["modifier"]

    # --- Class levels & total level ---
    class_levels = []
    total_level = 0
    for cls in (char.get("classes") or []):
        level = cls.get("level", 1)
        cls_name = (cls.get("definition") or {}).get("name", "Unknown")
        class_levels.append({"name": cls_name, "level": level})
        total_level += level
    if total_level < 1:
        total_level = 1
    prof_bonus = (total_level - 1) // 4 + 2

    # --- Skill proficiencies ---
    # D&DBeyond uses hyphenated lowercase subType names
    SKILL_MAP = {
        "athletics":         "athletics",
        "acrobatics":        "acrobatics",
        "sleight-of-hand":   "sleightOfHand",
        "stealth":           "stealth",
        "arcana":            "arcana",
        "history":           "history",
        "investigation":     "investigation",
        "nature":            "nature",
        "religion":          "religion",
        "animal-handling":   "animalHandling",
        "insight":           "insight",
        "medicine":          "medicine",
        "perception":        "perception",
        "survival":          "survival",
        "deception":         "deception",
        "intimidation":      "intimidation",
        "performance":       "performance",
        "persuasion":        "persuasion",
    }
    SKILL_ABILITY = {
        "athletics": "strength",
        "acrobatics": "dexterity", "sleightOfHand": "dexterity", "stealth": "dexterity",
        "arcana": "intelligence", "history": "intelligence", "investigation": "intelligence",
        "nature": "intelligence", "religion": "intelligence",
        "animalHandling": "wisdom", "insight": "wisdom", "medicine": "wisdom",
        "perception": "wisdom", "survival": "wisdom",
        "deception": "charisma", "intimidation": "charisma",
        "performance": "charisma", "persuasion": "charisma",
    }

    # D&DBeyond skill entity IDs (valueTypeId: "1958004211") -> our key
    # Used for characterValues manual proficiency overrides
    SKILL_ENTITY_ID_MAP = {
        1:  "acrobatics",
        2:  "athletics",
        3:  "animalHandling",
        4:  "sleightOfHand",
        5:  "stealth",
        6:  "arcana",
        7:  "history",
        8:  "investigation",
        9:  "nature",
        10: "religion",
        11: "insight",
        12: "medicine",
        13: "perception",
        14: "survival",
        15: "deception",
        16: "intimidation",
        17: "performance",
        18: "persuasion",
    }
    # Ability score stat IDs (valueTypeId: "1472902489") -> ability name
    ABILITY_ENTITY_ID_MAP = {
        1: "strength",
        2: "dexterity",
        3: "constitution",
        4: "intelligence",
        5: "wisdom",
        6: "charisma",
    }

    skill_prof = {}  # our_key -> 0, 1 (proficient), 2 (expertise)
    for m in all_mods:
        sub = m.get("subType", "")
        our_key = SKILL_MAP.get(sub)
        if not our_key:
            continue
        mtype = m.get("type", "")
        if mtype == "expertise":
            skill_prof[our_key] = 2
        elif mtype == "proficiency" and skill_prof.get(our_key, 0) < 2:
            skill_prof[our_key] = 1
        elif mtype == "half-proficiency" and skill_prof.get(our_key, 0) < 1:
            skill_prof[our_key] = -1  # half prof flag

    # --- Saving throws (from modifiers) ---
    SAVE_SUBTYPES = {
        "strength-saving-throws":     "strength",
        "dexterity-saving-throws":    "dexterity",
        "constitution-saving-throws": "constitution",
        "intelligence-saving-throws": "intelligence",
        "wisdom-saving-throws":       "wisdom",
        "charisma-saving-throws":     "charisma",
    }
    save_prof = set()
    for m in all_mods:
        if m.get("type") == "proficiency":
            ab = SAVE_SUBTYPES.get(m.get("subType", ""))
            if ab:
                save_prof.add(ab)

    # --- Apply characterValues manual proficiency overrides ---
    # typeId 26 = skill proficiency override (valueTypeId "1958004211")
    # typeId 41 = saving throw proficiency override (valueTypeId "1472902489")
    # value >= 3 → grant proficiency, value == 1 → explicitly remove proficiency
    for cv in (char.get("characterValues") or []):
        type_id  = cv.get("typeId")
        val      = cv.get("value")
        eid      = cv.get("valueId")  # comes as int or string
        if eid is not None:
            try:
                eid = int(eid)
            except (TypeError, ValueError):
                eid = None
        if eid is None:
            continue

        if type_id == 26:  # skill override
            our_key = SKILL_ENTITY_ID_MAP.get(eid)
            if our_key:
                if val is not None and val >= 3:
                    if skill_prof.get(our_key, 0) < 1:
                        skill_prof[our_key] = 1
                elif val == 1:
                    # Explicitly not proficient — only remove if currently at 1
                    # (preserve expertise if somehow granted)
                    if skill_prof.get(our_key, 0) == 1:
                        skill_prof[our_key] = 0

        elif type_id == 41:  # saving throw override
            ab_name = ABILITY_ENTITY_ID_MAP.get(eid)
            if ab_name:
                if val is not None and val >= 3:
                    save_prof.add(ab_name)
                elif val == 1:
                    save_prof.discard(ab_name)

    skills = {}
    for ddb_sub, our_key in SKILL_MAP.items():
        ab_mod = abilities[SKILL_ABILITY[our_key]]["modifier"]
        plevel = skill_prof.get(our_key, 0)
        if plevel == 2:
            value = ab_mod + prof_bonus * 2
            prof_num = 2
        elif plevel == 1:
            value = ab_mod + prof_bonus
            prof_num = 1
        elif plevel == -1:
            value = ab_mod + prof_bonus // 2
            prof_num = 0  # not shown as proficient dot
        else:
            value = ab_mod
            prof_num = 0
        skills[our_key] = {"value": value, "proficiency": prof_num}

    saves = {}
    for ab_name, ab_data in abilities.items():
        has_prof = ab_name in save_prof
        value = ab_data["modifier"] + (prof_bonus if has_prof else 0)
        saves[ab_name] = {"value": value, "proficiency": 1 if has_prof else 0}

    # --- HP ---
    hp_max = char.get("overrideHitPoints") or (
        (char.get("baseHitPoints") or 0) + (char.get("bonusHitPoints") or 0)
    )
    hp_removed = char.get("removedHitPoints") or 0
    hp_temp    = char.get("temporaryHitPoints") or 0
    hp_current = max(0, hp_max - hp_removed)

    # --- AC, Speed, Initiative ---
    ac = _ddb_compute_ac(char, dex_mod, all_mods)
    speed = _ddb_compute_speed(char, all_mods)
    init_bonus = dex_mod
    for m in all_mods:
        if m.get("type") == "bonus" and m.get("subType") == "initiative":
            init_bonus += m.get("value") or 0

    # --- Spell slots ---
    # In D&DBeyond API: available = remaining slots, used = slots spent,
    # total = used + available (NOT just available).
    spell_slots = []
    for slot in (char.get("spellSlots") or []):
        level     = slot.get("level", 0)
        available = slot.get("available", 0) or 0
        used      = slot.get("used", 0) or 0
        total     = used + available
        if total > 0:
            spell_slots.append({
                "name": f"Level {level}",
                "value": available,
                "total": total,
                "variableName": f"spellSlot{level}",
            })
    for slot in (char.get("pactMagic") or []):
        level     = slot.get("level", 0)
        available = slot.get("available", 0) or 0
        used      = slot.get("used", 0) or 0
        total     = used + available
        if total > 0:
            spell_slots.append({
                "name": f"Pact Level {level}",
                "value": available,
                "total": total,
                "variableName": f"pactSlot{level}",
            })

    # --- Conditions (active status effects from condition modifiers) ---
    conditions = []
    for m in (char.get("modifiers") or {}).get("condition", []):
        label = m.get("friendlySubTypeName") or m.get("subType", "")
        if label:
            conditions.append(label)

    return {
        "id": str(character_id),
        "name": name,
        "avatar": avatar,
        "hp": {"current": hp_current, "max": hp_max, "temp": hp_temp},
        "ac": ac,
        "speed": speed,
        "initiative_bonus": init_bonus,
        "abilities": abilities,
        "skills": skills,
        "saves": saves,
        "resources": [],
        "spell_slots": spell_slots,
        "conditions": conditions,
        "class_levels": class_levels,
        "proficiency_bonus": prof_bonus,
        "death_saves": {},
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
