// main.js — VTT session glue layer

// --- Constants ---

const ABILITY_LABELS = {
  strength: "STR", dexterity: "DEX", constitution: "CON",
  intelligence: "INT", wisdom: "WIS", charisma: "CHA",
};

const SKILL_LABELS = {
  athletics: "Athletics",
  acrobatics: "Acrobatics",
  sleightOfHand: "Sleight of Hand",
  stealth: "Stealth",
  arcana: "Arcana",
  history: "History",
  investigation: "Investigation",
  nature: "Nature",
  religion: "Religion",
  animalHandling: "Animal Handling",
  insight: "Insight",
  medicine: "Medicine",
  perception: "Perception",
  survival: "Survival",
  deception: "Deception",
  intimidation: "Intimidation",
  performance: "Performance",
  persuasion: "Persuasion",
};

// --- State ---

const ROLE = document.body.dataset.role;
const SESSION_CODE = document.body.dataset.code;
const MY_NAME = document.body.dataset.name;

let socket;
let sessionTokens = {};     // token_id -> token
let fogRevealed = new Set(); // "col,row" strings of revealed cells
window.fogRevealed = fogRevealed;
let initiativeOrder = [];
let currentTurn = -1;
let onlinePlayers = {};     // sid -> { name }
let partyCharacters = {};   // character_id -> { player_uuid, player_sid, character }
let playerCharacters = {};  // character_id -> char_data  (this player's own chars)
let currentCharId = null;   // which character sheet is currently displayed
// selectedTokenId is declared in map.js — shared global scope

// --- Socket setup ---

socket = io();

window.MY_SID = null;
window.MY_UUID = null;
window.socketEmit = (event, data) => socket.emit(event, data);
window.onTokenSelected = onTokenSelected;
window.openEditToken = openEditToken;
window.onMultipleSelected = () => {
  document.getElementById("token-hp-editor")?.classList.add("hidden");
  const removeBtn = document.getElementById("remove-token-btn");
  if (removeBtn) removeBtn.disabled = ROLE !== "dm";
};
window.getToken = (id) => sessionTokens[id];

socket.on("connect", () => {
  document.getElementById("connection-status").className = "status-dot connected";
  document.getElementById("connection-status").title = "Connected";
});

socket.on("disconnect", () => {
  document.getElementById("connection-status").className = "status-dot disconnected";
  document.getElementById("connection-status").title = "Disconnected";
});

// Full state dump on join
socket.on("session_state", (data) => {
  window.MY_SID = data.my_sid;
  window.MY_UUID = data.my_uuid || null;
  onlinePlayers = data.players || {};

  const map = data.map;
  const colsEl = document.getElementById("grid-cols");
  const rowsEl = document.getElementById("grid-rows");
  if (colsEl) colsEl.value = map.cols;
  if (rowsEl) rowsEl.value = map.rows;
  initMap(map.cols, map.rows);
  window._currentMapUrl = map.image_url || null;
  window._currentMapScaleX = map.scale_x ?? 1;
  window._currentMapScaleY = map.scale_y ?? 1;
  if (map.image_url) {
    setMapImage(map.image_url, map.offset_x || 0, map.offset_y || 0, map.scale_x ?? 1, map.scale_y ?? 1);
  }
  syncMapOffsetInputs(map.offset_x || 0, map.offset_y || 0);
  toggleMapImageControls(!!map.image_url);

  // Load tokens
  sessionTokens = {};
  for (const token of data.tokens) {
    sessionTokens[token.id] = token;
    addTokenToMap(token);
  }

  // Load spell shape overlays
  window.clearSpellShapesFromMap?.();
  for (const shape of (data.spell_shapes || [])) {
    window.addSpellShapeToMap?.(shape);
  }

  // Load fog of war
  fogRevealed.clear();
  for (const [col, row] of (data.fog || [])) {
    fogRevealed.add(`${col},${row}`);
  }
  window.renderFog?.(fogRevealed, ROLE === "dm");
  window.updateTokenFogVisibility?.();

  // Load map profiles (DM only)
  if (ROLE === "dm") {
    renderMapProfiles(data.map_profiles || [], data.active_profile_id ?? null);
    renderLibrary(data.token_library || []);
  }

  // Chat history
  for (const msg of data.chat) {
    appendChat(msg, false);
  }

  // Initiative / combat state
  initiativeOrder = data.initiative_order || [];
  currentTurn = data.current_turn ?? -1;
  renderInitiative();

  if (currentTurn >= 0 && initiativeOrder.length > 0) {
    const activeId = initiativeOrder[currentTurn];
    highlightCurrentTurn(activeId);
    updateTurnIndicator(activeId);
    setCombatButtonState(true);
  }

  updatePlayerCount();

  // DM: populate party panel from session state
  if (ROLE === "dm" && data.party_characters) {
    renderPartyPanel(data.party_characters);
  }
});

// --- Token events ---

socket.on("token_added", (token) => {
  sessionTokens[token.id] = token;
  addTokenToMap(token);
});

socket.on("token_removed", (data) => {
  delete sessionTokens[data.id];
  removeTokenFromMap(data.id);
  if (selectedTokenId === data.id) onTokenSelected(null);
});

socket.on("ping", (data) => {
  showPing(data.x, data.y, data.color);
});

socket.on("spell_shape_added",   (data) => { window.addSpellShapeToMap?.(data); });
socket.on("spell_shape_removed",  (data) => { window.removeSpellShapeFromMap?.(data.id); });
socket.on("spell_shapes_cleared", ()     => { window.clearSpellShapesFromMap?.(); });

socket.on("map_profiles_updated", (data) => {
  if (ROLE !== "dm") return;
  renderMapProfiles(data.profiles, data.active_profile_id ?? null);
});

socket.on("fog_updated", (data) => {
  fogRevealed.clear();
  for (const [col, row] of (data.fog || [])) {
    fogRevealed.add(`${col},${row}`);
  }
  window.renderFog?.(fogRevealed, ROLE === "dm");
  window.updateTokenFogVisibility?.();
});

socket.on("library_updated", (data) => {
  if (ROLE === "dm") renderLibrary(data.entries || []);
});

socket.on("token_moved", (data) => {
  const token = sessionTokens[data.id];
  if (!token) return;
  token.x = data.x;
  token.y = data.y;
  updateTokenOnMap(token);
});

socket.on("token_updated", (token) => {
  // Players never see hidden tokens
  if (ROLE !== "dm" && token.hidden) {
    if (sessionTokens[token.id]) {
      removeTokenFromMap(token.id);
      delete sessionTokens[token.id];
    }
    return;
  }

  const old = sessionTokens[token.id];
  sessionTokens[token.id] = token;
  // Rebuild if size or image changed — simple update can't handle those
  if (!old || old.size !== token.size || old.image_url !== token.image_url) {
    const wasSelected = selectedTokenId === token.id;
    removeTokenFromMap(token.id);
    addTokenToMap(token);
    if (wasSelected) selectToken(token.id);
  } else {
    updateTokenOnMap(token);
  }
  if (getSelectedTokenId() === token.id) refreshHpEditor(token);
});

socket.on("hp_updated", (data) => {
  const token = sessionTokens[data.id];
  if (!token) return;
  token.hp = data.hp;
  token.max_hp = data.max_hp;
  updateTokenOnMap(token);
  if (selectedTokenId === data.id) refreshHpEditor(token);
});

// --- Combat events ---

socket.on("combat_started", (data) => {
  initiativeOrder = data.order;
  currentTurn = data.current_turn;
  for (const token of data.tokens) {
    sessionTokens[token.id] = token;
  }
  renderInitiative();
  const activeId = initiativeOrder[currentTurn];
  highlightCurrentTurn(activeId);
  updateTurnIndicator(activeId);
  setCombatButtonState(true);
});

socket.on("turn_changed", (data) => {
  currentTurn = data.current_turn;
  const activeId = initiativeOrder[currentTurn];
  renderInitiative();
  highlightCurrentTurn(activeId);
  updateTurnIndicator(activeId);
});

socket.on("combat_ended", () => {
  initiativeOrder = [];
  currentTurn = -1;
  renderInitiative();
  highlightCurrentTurn(null);
  updateTurnIndicator(null);
  setCombatButtonState(false);
});

socket.on("map_resized", (data) => {
  const colsEl = document.getElementById("grid-cols");
  const rowsEl = document.getElementById("grid-rows");
  if (colsEl) colsEl.value = data.cols;
  if (rowsEl) rowsEl.value = data.rows;
  initMap(data.cols, data.rows);
  for (const token of Object.values(sessionTokens)) {
    addTokenToMap(token);
  }
  window.renderFog?.(fogRevealed, ROLE === "dm");
  window.updateTokenFogVisibility?.();
});

socket.on("map_image_updated", (data) => {
  const sx = data.scale_x ?? 1, sy = data.scale_y ?? 1;
  window._currentMapScaleX = sx;
  window._currentMapScaleY = sy;
  syncMapOffsetInputs(data.offset_x, data.offset_y);
  toggleMapImageControls(!!data.url);
  if (data.url && data.url === (window._currentMapUrl || null)) {
    setMapOffset(data.offset_x, data.offset_y, sx, sy);
  } else {
    window._currentMapUrl = data.url || null;
    setMapImage(data.url || null, data.offset_x, data.offset_y, sx, sy);
  }
});

// --- Player events ---

socket.on("player_joined", (data) => {
  onlinePlayers[data.sid] = { name: data.name, uuid: data.uuid };
  updatePlayerCount();
});

socket.on("player_left", (data) => {
  delete onlinePlayers[data.sid];
  updatePlayerCount();
});

// --- Chat events ---

socket.on("chat_entry", (msg) => appendChat(msg, true));

// --- Error events ---

socket.on("error_msg", (data) => appendSystemMsg(data.message));
socket.on("dicecloud_error", (data) => {
  const errEl = document.getElementById("dc-error");
  if (errEl) {
    errEl.textContent = data.message;
    errEl.classList.remove("hidden");
  }
  resetRefreshBtn();
});

// --- DM party panel ---

function renderPartyPanel(entries) {
  for (const entry of entries) {
    const key = entry.character_id || entry.player_uuid;
    partyCharacters[key] = {
      player_uuid: entry.player_uuid,
      player_sid: entry.player_sid || null,
      character: entry.character,
    };
  }
  const list = document.getElementById("party-list");
  if (!list) return;
  list.innerHTML = "";
  const keys = Object.keys(partyCharacters);
  if (keys.length === 0) {
    list.innerHTML = '<div id="party-empty" class="party-empty">No characters loaded yet.</div>';
    return;
  }
  for (const key of keys) {
    list.appendChild(buildPartyCard(key));
  }
}

function upsertPartyCard(key) {
  const list = document.getElementById("party-list");
  if (!list) return;
  const empty = document.getElementById("party-empty");
  if (empty) empty.remove();
  const existing = document.getElementById(`party-card-${key}`);
  const card = buildPartyCard(key);
  if (existing) {
    existing.replaceWith(card);
  } else {
    list.appendChild(card);
  }
}

function buildPartyCard(key) {
  const entry = partyCharacters[key];
  const char = entry.character;

  const classStr = (char.class_levels || [])
    .map(cl => `${cl.name} ${cl.level}`)
    .join(" / ");
  const hpStr = `${char.hp?.current ?? "?"}/${char.hp?.max ?? "?"}`;
  const initBonus = char.initiative_bonus ?? 0;
  const initStr = initBonus >= 0 ? `+${initBonus}` : `${initBonus}`;

  const card = document.createElement("div");
  card.className = "party-card";
  card.id = `party-card-${key}`;

  // Header: avatar + name/class/player
  const header = document.createElement("div");
  header.className = "party-card-header";

  if (char.avatar) {
    const img = document.createElement("img");
    img.className = "party-avatar-sm";
    img.src = char.avatar;
    img.alt = "";
    img.onerror = () => img.remove();
    header.appendChild(img);
  }

  const info = document.createElement("div");
  info.className = "party-char-info";

  const nameEl = document.createElement("div");
  nameEl.className = "party-char-name";
  nameEl.textContent = char.name;

  const classEl = document.createElement("div");
  classEl.className = "party-char-class";
  classEl.textContent = classStr;

  info.appendChild(nameEl);
  info.appendChild(classEl);

  if (char.player_name) {
    const playerEl = document.createElement("div");
    playerEl.className = "party-player-name";
    playerEl.textContent = `played by ${char.player_name}`;
    info.appendChild(playerEl);
  }

  header.appendChild(info);
  card.appendChild(header);

  // Stats row
  const statsRow = document.createElement("div");
  statsRow.className = "party-stats-row";
  statsRow.innerHTML = `<span title="Hit Points">HP ${hpStr}</span>
    <span title="Armor Class">AC ${char.ac ?? "?"}</span>
    <span title="Initiative Bonus">Init ${initStr}</span>`;
  card.appendChild(statsRow);

  // Spawn button
  const btn = document.createElement("button");
  btn.className = "btn-primary btn-sm party-spawn-btn";
  btn.textContent = "Spawn Token";
  btn.onclick = () => spawnCharacterToken(key);
  card.appendChild(btn);

  return card;
}

function spawnCharacterToken(key) {
  const entry = partyCharacters[key];
  if (!entry) return;
  const char = entry.character;
  openAddToken({
    name: char.name,
    hp: char.hp?.current ?? 10,
    maxHp: char.hp?.max ?? 10,
    color: "#3498db",
    imageUrl: char.avatar || "",
    size: 1,
    playerSid: entry.player_sid,  // current SID (null if offline — DM can assign manually)
  });
}

// --- Character sheet ---

socket.on("character_loaded", (data) => {
  const charId = data.character_id;
  const char   = data.character;
  playerCharacters[charId] = char;
  addOrUpdateCharTab(charId, char.name);
  // Auto-switch to first character; update display if re-loading current
  if (!currentCharId || currentCharId === charId) switchToCharacter(charId);
  resetRefreshBtn();
});

socket.on("character_removed", (data) => {
  const charId = data.character_id;
  if (ROLE === "dm") {
    // Remove from DM party panel
    delete partyCharacters[charId];
    document.getElementById(`party-card-${charId}`)?.remove();
    const list = document.getElementById("party-list");
    if (list && list.children.length === 0) {
      list.innerHTML = '<div id="party-empty" class="party-empty">No characters loaded yet.</div>';
    }
    return;
  }
  // Player: remove tab and fall back
  delete playerCharacters[charId];
  document.getElementById(`char-tab-${charId}`)?.remove();
  if (currentCharId === charId) {
    currentCharId = null;
    const remaining = Object.keys(playerCharacters);
    if (remaining.length > 0) {
      switchToCharacter(remaining[0]);
    } else {
      document.getElementById("char-stats")?.classList.add("hidden");
      document.getElementById("char-tabs-bar")?.classList.add("hidden");
      showDcLoginForm();
    }
  }
});

socket.on("character_shared", (data) => {
  if (ROLE !== "dm") return;
  const key = data.character_id || data.player_uuid;
  partyCharacters[key] = {
    player_uuid: data.player_uuid,
    player_sid: data.player_sid,
    character: data.character,
  };
  upsertPartyCard(key);
});

function renderCharacterSheet(char) {
  // Swap panels
  const loginSection = document.getElementById("dc-login-section");
  if (loginSection) loginSection.classList.add("hidden");
  document.getElementById("char-stats").classList.remove("hidden");

  // Header
  document.getElementById("char-name").textContent = char.name;
  const classes = (char.class_levels || [])
    .map(cl => `${cl.name} ${cl.level}`)
    .join(" / ");
  document.getElementById("char-class").textContent = classes;

  const avatarEl = document.getElementById("char-avatar");
  if (char.avatar) {
    avatarEl.src = char.avatar;
    avatarEl.classList.remove("hidden");
  } else {
    avatarEl.src = "";
    avatarEl.classList.add("hidden");
  }

  // Top stats
  document.getElementById("stat-ac").textContent = char.ac ?? "—";
  document.getElementById("stat-speed").textContent = char.speed ? `${char.speed}ft` : "—";
  const initBonus = char.initiative_bonus ?? 0;
  document.getElementById("stat-init").textContent = initBonus >= 0 ? `+${initBonus}` : `${initBonus}`;
  const prof = char.proficiency_bonus ?? 2;
  document.getElementById("stat-prof").textContent = `+${prof}`;

  // Ability scores
  const abilityGrid = document.getElementById("ability-grid");
  abilityGrid.innerHTML = "";
  for (const [key, label] of Object.entries(ABILITY_LABELS)) {
    const ab = char.abilities?.[key] || { score: 10, modifier: 0 };
    const mod = ab.modifier >= 0 ? `+${ab.modifier}` : `${ab.modifier}`;
    const cell = document.createElement("div");
    cell.className = "ability-box";
    cell.innerHTML = `<div class="ability-name">${label}</div>
                      <div class="ability-score">${ab.score}</div>
                      <div class="ability-mod">${mod}</div>`;
    abilityGrid.appendChild(cell);
  }

  // Saving throws
  const saveList = document.getElementById("save-list");
  saveList.innerHTML = "";
  for (const [key, label] of Object.entries(ABILITY_LABELS)) {
    const save = char.saves?.[key] || { value: 0, proficiency: 0 };
    const val = save.value >= 0 ? `+${save.value}` : `${save.value}`;
    const profClass = save.proficiency > 0 ? " proficient" : "";
    const row = document.createElement("div");
    row.className = "save-item";
    row.innerHTML = `<span class="prof-dot${profClass}"></span>
                     <span style="min-width:28px;font-weight:600">${val}</span>
                     <span>${label}</span>`;
    saveList.appendChild(row);
  }

  // Skills
  const skillList = document.getElementById("skill-list");
  skillList.innerHTML = "";
  for (const [key, label] of Object.entries(SKILL_LABELS)) {
    const skill = char.skills?.[key];
    const val = skill ? (skill.value >= 0 ? `+${skill.value}` : `${skill.value}`) : "+0";
    const profClass = skill?.proficiency >= 2 ? " proficient" : skill?.proficiency > 0 ? " half" : "";
    const row = document.createElement("div");
    row.className = "skill-item";
    row.innerHTML = `<span class="prof-dot${profClass}"></span>
                     <span class="skill-val">${val}</span>
                     <span>${label}</span>`;
    skillList.appendChild(row);
  }

  // Resources
  const resources = char.resources || [];
  const resourceSection = document.getElementById("resources-section");
  const resourceList = document.getElementById("resource-list");
  resourceList.innerHTML = "";
  if (resources.length > 0) {
    for (const res of resources) {
      const row = document.createElement("div");
      row.className = "resource-item";
      row.innerHTML = `<span>${res.name}</span>
                       <span>${res.value} / ${res.total}</span>`;
      resourceList.appendChild(row);
    }
    resourceSection.classList.remove("hidden");
  } else {
    resourceSection.classList.add("hidden");
  }

  // Spell slots
  const spellSlots = char.spell_slots || [];
  const spellSection = document.getElementById("spellslots-section");
  const spellList = document.getElementById("spellslot-list");
  spellList.innerHTML = "";
  if (spellSlots.length > 0) {
    for (const slot of spellSlots) {
      const row = document.createElement("div");
      row.className = "resource-item";
      row.innerHTML = `<span>${slot.name}</span>
                       <span>${slot.value} / ${slot.total}</span>`;
      spellList.appendChild(row);
    }
    spellSection.classList.remove("hidden");
  } else {
    spellSection.classList.add("hidden");
  }

  // Conditions
  const conditions = char.conditions || [];
  const condSection = document.getElementById("conditions-section");
  const condList = document.getElementById("conditions-list");
  condList.innerHTML = "";
  if (conditions.length > 0) {
    for (const cond of conditions) {
      const tag = document.createElement("span");
      tag.className = "condition-tag";
      tag.textContent = cond;
      condList.appendChild(tag);
    }
    condSection.classList.remove("hidden");
  } else {
    condSection.classList.add("hidden");
  }
}

// --- Character tabs ---

function addOrUpdateCharTab(charId, name) {
  const bar  = document.getElementById("char-tabs-bar");
  const tabs = document.getElementById("char-tabs");
  if (!bar || !tabs) return;
  bar.classList.remove("hidden");
  let tab = document.getElementById(`char-tab-${charId}`);
  if (!tab) {
    tab = document.createElement("button");
    tab.id = `char-tab-${charId}`;
    tab.className = "char-tab";
    tab.onclick = () => switchToCharacter(charId);
    tabs.appendChild(tab);
  }
  tab.textContent = name;
}

function switchToCharacter(charId) {
  currentCharId = charId;
  document.querySelectorAll(".char-tab").forEach(t => {
    t.classList.toggle("active", t.id === `char-tab-${charId}`);
  });
  document.getElementById("dc-login-section")?.classList.add("hidden");
  const char = playerCharacters[charId];
  if (char) renderCharacterSheet(char);
}

function showDcLoginForm() {
  document.getElementById("dc-login-section")?.classList.remove("hidden");
  document.getElementById("char-stats")?.classList.add("hidden");
  document.querySelectorAll(".char-tab").forEach(t => t.classList.remove("active"));
}

// --- DiceCloud login / refresh ---

function refreshCharacter() {
  if (!currentCharId) return;
  const btn = document.getElementById("refresh-char-btn");
  if (btn) { btn.disabled = true; btn.textContent = "↻ Updating..."; }
  const errEl = document.getElementById("dc-error");
  if (errEl) errEl.classList.add("hidden");
  socket.emit("refresh_character", { character_id: currentCharId });
}

function removeCharacter() {
  if (!currentCharId) return;
  const char = playerCharacters[currentCharId];
  if (!confirm(`Remove ${char?.name || "this character"}?`)) return;
  socket.emit("remove_character", { character_id: currentCharId });
}

function resetRefreshBtn() {
  const btn = document.getElementById("refresh-char-btn");
  if (btn) { btn.disabled = false; btn.textContent = "↻ Update"; }
}

function switchImportTab(tab) {
  document.getElementById("import-dicecloud").classList.toggle("hidden", tab !== "dicecloud");
  document.getElementById("import-dndbeyond").classList.toggle("hidden", tab !== "dndbeyond");
  document.getElementById("tab-dicecloud").classList.toggle("active", tab === "dicecloud");
  document.getElementById("tab-dndbeyond").classList.toggle("active", tab === "dndbeyond");
  document.getElementById("dc-error").classList.add("hidden");
}

function dcLogin() {
  const username = document.getElementById("dc-username").value.trim();
  const password = document.getElementById("dc-password").value;
  const charId = document.getElementById("dc-char-id").value.trim();
  const errEl = document.getElementById("dc-error");

  if (!username || !password || !charId) {
    errEl.textContent = "All fields required.";
    errEl.classList.remove("hidden");
    return;
  }

  errEl.classList.add("hidden");
  socket.emit("dicecloud_login", { username, password, character_id: charId });
}

function dndbeyondImport() {
  const charId = document.getElementById("ddb-char-id").value.trim();
  const errEl = document.getElementById("dc-error");

  if (!charId) {
    errEl.textContent = "Character ID required.";
    errEl.classList.remove("hidden");
    return;
  }
  if (!/^\d+$/.test(charId)) {
    errEl.textContent = "Character ID must be a number (found in the D&D Beyond character URL).";
    errEl.classList.remove("hidden");
    return;
  }

  errEl.classList.add("hidden");
  socket.emit("dndbeyond_import", { character_id: charId });
}

// --- Map controls (DM) ---

function applyGridSize() {
  const cols = Math.max(5, Math.min(50, parseInt(document.getElementById("grid-cols").value) || 20));
  const rows = Math.max(5, Math.min(50, parseInt(document.getElementById("grid-rows").value) || 15));
  socket.emit("resize_map", { cols, rows });
}

function uploadMapImage() {
  const input = document.getElementById("map-image-input");
  const file = input?.files?.[0];
  if (!file) return;
  const btn = document.getElementById("upload-map-btn");
  btn.disabled = true;
  btn.textContent = "Uploading...";
  const formData = new FormData();
  formData.append("file", file);
  fetch(`/session/${SESSION_CODE}/upload_map`, { method: "POST", body: formData })
    .then(r => r.json())
    .then(data => {
      if (data.error) showMapImageError(data.error);
      input.value = "";
    })
    .catch(() => showMapImageError("Upload failed."))
    .finally(() => { btn.disabled = false; btn.textContent = "Upload"; });
}

function clearMapImage() {
  socket.emit("clear_map_image");
}

function nudgeMap(dx, dy, event) {
  const step = event?.shiftKey ? 10 : 1;
  const xEl = document.getElementById("map-offset-x");
  const yEl = document.getElementById("map-offset-y");
  const offsetX = parseFloat(xEl?.value || 0) + dx * step;
  const offsetY = parseFloat(yEl?.value || 0) + dy * step;
  syncMapOffsetInputs(offsetX, offsetY);
  socket.emit("set_map_offset", {
    offset_x: offsetX,
    offset_y: offsetY,
    scale_x: window._currentMapScaleX ?? 1,
    scale_y: window._currentMapScaleY ?? 1,
  });
}

function syncMapOffsetInputs(x, y) {
  const xEl = document.getElementById("map-offset-x");
  const yEl = document.getElementById("map-offset-y");
  if (xEl) xEl.value = Math.round(x);
  if (yEl) yEl.value = Math.round(y);
}

function toggleMapImageControls(hasImage) {
  const nudgeEl = document.getElementById("map-nudge-controls");
  if (nudgeEl) nudgeEl.classList.toggle("hidden", !hasImage);
}

function renderMapProfiles(profiles, activeId) {
  const list = document.getElementById("map-profiles-list");
  if (!list) return;
  list.innerHTML = "";
  if (!profiles || profiles.length === 0) {
    list.innerHTML = '<div class="profiles-empty">No saved profiles.</div>';
    return;
  }
  for (const p of profiles) {
    const isActive = p.id === activeId;
    const row = document.createElement("div");
    row.className = "profile-row" + (isActive ? " profile-active" : "");

    const nameEl = document.createElement("span");
    nameEl.className = "profile-name";
    nameEl.textContent = p.name;
    row.appendChild(nameEl);

    if (!isActive) {
      const loadBtn = document.createElement("button");
      loadBtn.className = "btn-sm profile-btn";
      loadBtn.textContent = "Load";
      loadBtn.onclick = () => loadMapProfile(p.id);
      row.appendChild(loadBtn);
    }

    const delBtn = document.createElement("button");
    delBtn.className = "btn-sm btn-danger profile-btn";
    delBtn.textContent = "✕";
    delBtn.title = "Delete profile";
    delBtn.onclick = () => {
      if (confirm(`Delete profile "${p.name}"?`)) deleteMapProfile(p.id);
    };
    row.appendChild(delBtn);

    list.appendChild(row);
  }
}

function saveMapProfile() {
  const input = document.getElementById("profile-name-input");
  const name = input?.value.trim();
  if (!name) { input?.focus(); return; }
  socket.emit("save_map_profile", { name });
  if (input) input.value = "";
}

function loadMapProfile(id) {
  socket.emit("load_map_profile", { id });
}

function deleteMapProfile(id) {
  socket.emit("delete_map_profile", { id });
}

function fogRevealAll() {
  socket.emit("fog_reset", { mode: "all_revealed" });
}

function fogResetAll() {
  if (!confirm("Fog the entire map?")) return;
  socket.emit("fog_reset", { mode: "all_fogged" });
}

function showMapImageError(msg) {
  const el = document.getElementById("map-image-error");
  if (!el) return;
  el.textContent = msg;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 4000);
}

// --- Token management (DM) ---

function openAddToken(prefill = null) {
  // Populate player select
  const wrap = document.getElementById("tok-player-select-wrap");
  const select = document.getElementById("tok-player-select");
  select.innerHTML = "";
  for (const [sid, player] of Object.entries(onlinePlayers)) {
    const opt = document.createElement("option");
    opt.value = sid;
    opt.textContent = player.name;
    select.appendChild(opt);
  }

  const checkbox = document.getElementById("tok-isplayer");
  checkbox.onchange = () => {
    wrap.classList.toggle("hidden", !checkbox.checked);
  };

  if (prefill) {
    if (prefill.name     !== undefined) document.getElementById("tok-name").value    = prefill.name;
    if (prefill.hp       !== undefined) document.getElementById("tok-hp").value      = prefill.hp;
    if (prefill.maxHp    !== undefined) document.getElementById("tok-maxhp").value   = prefill.maxHp;
    if (prefill.color    !== undefined) document.getElementById("tok-color").value   = prefill.color;
    if (prefill.imageUrl !== undefined) document.getElementById("tok-image").value   = prefill.imageUrl;
    if (prefill.size     !== undefined) document.getElementById("tok-size").value    = prefill.size;

    // playerSid: try to pre-select a specific player in the dropdown
    const hasPlayer = !!prefill.playerSid && !!select.querySelector(`option[value="${prefill.playerSid}"]`);
    checkbox.checked = hasPlayer;
    wrap.classList.toggle("hidden", !hasPlayer);
    if (hasPlayer) select.value = prefill.playerSid;
  } else {
    checkbox.checked = false;
    wrap.classList.add("hidden");
  }

  document.getElementById("add-token-modal").classList.remove("hidden");
}

function submitAddToken() {
  const isPlayer = document.getElementById("tok-isplayer").checked;
  const playerId = isPlayer
    ? document.getElementById("tok-player-select").value
    : null;

  socket.emit("add_token", {
    name: document.getElementById("tok-name").value || "Token",
    hp: parseInt(document.getElementById("tok-hp").value) || 10,
    max_hp: parseInt(document.getElementById("tok-maxhp").value) || 10,
    color: document.getElementById("tok-color").value,
    size: parseInt(document.getElementById("tok-size").value) || 1,
    image_url: document.getElementById("tok-image").value.trim() || null,
    is_player: isPlayer,
    player_id: playerId,
    x: window.getViewportCenterCell?.().col ?? 0,
    y: window.getViewportCenterCell?.().row ?? 0,
  });
  closeModal();
}

let _editingTokenId = null;

function openEditToken(tokenId) {
  const token = sessionTokens[tokenId];
  if (!token) return;
  _editingTokenId = tokenId;

  document.getElementById("edit-tok-name").value = token.name;
  document.getElementById("edit-tok-hp").value = token.hp;
  document.getElementById("edit-tok-maxhp").value = token.max_hp;
  document.getElementById("edit-tok-color").value = token.color || "#e74c3c";
  document.getElementById("edit-tok-size").value = token.size || 1;
  document.getElementById("edit-tok-image").value = token.image_url || "";

  // Populate condition checkboxes
  const exhCount = (token.conditions || []).filter(c => c === "exhaustion").length;
  document.getElementById("edit-tok-exhaustion-val").textContent = exhCount;
  document.querySelectorAll(".condition-grid .cond-toggle input[type=checkbox]").forEach(cb => {
    cb.checked = (token.conditions || []).includes(cb.value);
  });

  const playerSection = document.getElementById("edit-tok-player-section");
  if (ROLE === "dm") {
    document.getElementById("edit-tok-hidden").checked = !!token.hidden;
    document.getElementById("edit-tok-show-hp").checked = token.show_hp !== false;
    const initModEl = document.getElementById("edit-tok-initiative-mod");
    if (initModEl) initModEl.value = token.initiative_mod ?? 0;
    playerSection.classList.remove("hidden");
    const select = document.getElementById("edit-tok-player-select");
    select.innerHTML = "";
    for (const [sid, player] of Object.entries(onlinePlayers)) {
      const opt = document.createElement("option");
      opt.value = sid;
      opt.textContent = player.name;
      select.appendChild(opt);
    }
    const checkbox = document.getElementById("edit-tok-isplayer");
    const wrap = document.getElementById("edit-tok-player-select-wrap");
    checkbox.checked = !!token.is_player;
    wrap.classList.toggle("hidden", !token.is_player);
    checkbox.onchange = () => wrap.classList.toggle("hidden", !checkbox.checked);
    // Pre-select the assigned player if they're online
    if (token.player_id) {
      const sid = Object.entries(onlinePlayers).find(([, p]) => p.uuid === token.player_id)?.[0];
      if (sid) select.value = sid;
    }
  } else {
    playerSection.classList.add("hidden");
  }

  document.getElementById("edit-token-modal").classList.remove("hidden");
}

function stepExhaustion(delta) {
  const el = document.getElementById("edit-tok-exhaustion-val");
  const val = Math.max(0, Math.min(6, (parseInt(el.textContent) || 0) + delta));
  el.textContent = val;
}

function submitEditToken() {
  if (!_editingTokenId) return;
  const isPlayer = ROLE === "dm" && document.getElementById("edit-tok-isplayer").checked;
  // Collect conditions
  const conditions = [];
  document.querySelectorAll(".condition-grid .cond-toggle input[type=checkbox]:checked").forEach(cb => {
    conditions.push(cb.value);
  });
  const exhVal = parseInt(document.getElementById("edit-tok-exhaustion-val").textContent) || 0;
  for (let i = 0; i < exhVal; i++) conditions.push("exhaustion");

  const data = {
    id: _editingTokenId,
    name: document.getElementById("edit-tok-name").value || "Token",
    hp: parseInt(document.getElementById("edit-tok-hp").value) || 0,
    max_hp: parseInt(document.getElementById("edit-tok-maxhp").value) || 10,
    color: document.getElementById("edit-tok-color").value,
    size: parseInt(document.getElementById("edit-tok-size").value) || 1,
    image_url: document.getElementById("edit-tok-image").value.trim() || null,
    conditions,
  };
  if (ROLE === "dm") {
    data.is_player = isPlayer;
    data.player_id = isPlayer ? document.getElementById("edit-tok-player-select").value : null;
    data.hidden = document.getElementById("edit-tok-hidden").checked;
    data.show_hp = document.getElementById("edit-tok-show-hp").checked;
    data.initiative_mod = parseInt(document.getElementById("edit-tok-initiative-mod")?.value) || 0;
  }
  socket.emit("update_token", data);
  closeModal();
}

function removeSelected() {
  window.getSelectedTokenIds().forEach(id => socket.emit("remove_token", { id }));
}

function closeModal() {
  document.querySelectorAll(".modal").forEach(m => m.classList.add("hidden"));
}

// --- HP editor ---

function onTokenSelected(tokenId) {
  selectedTokenId = tokenId;
  const editor = document.getElementById("token-hp-editor");
  const removeBtn = document.getElementById("remove-token-btn");

  if (!tokenId) {
    editor.classList.add("hidden");
    if (removeBtn) removeBtn.disabled = true;
    return;
  }

  const token = sessionTokens[tokenId];
  if (!token) return;

  refreshHpEditor(token);
  editor.classList.remove("hidden");
  if (removeBtn) removeBtn.disabled = false;
}

function refreshHpEditor(token) {
  document.getElementById("hp-token-name").textContent = token.name;
  document.getElementById("hp-display").textContent = `${token.hp} / ${token.max_hp}`;
}

function adjustHp(delta) {
  const token = sessionTokens[selectedTokenId];
  if (!token) return;
  const newHp = Math.max(0, Math.min(token.hp + delta, token.max_hp));
  socket.emit("update_hp", { id: selectedTokenId, hp: newHp });
}

function setHp() {
  const token = sessionTokens[selectedTokenId];
  if (!token) return;
  const val = parseInt(document.getElementById("hp-input").value);
  if (isNaN(val)) return;
  const newHp = Math.max(0, Math.min(val, token.max_hp));
  socket.emit("update_hp", { id: selectedTokenId, hp: newHp });
  document.getElementById("hp-input").value = "";
}

// --- Combat controls ---

function startCombat() {
  const form = document.getElementById("initiative-form");
  form.innerHTML = "";

  for (const token of Object.values(sessionTokens)) {
    const row = document.createElement("div");
    row.className = "init-input-row";
    row.innerHTML = `<label>${token.name}
      <input type="number" data-token-id="${token.id}" value="${token.initiative || 0}" min="-20" max="30">
    </label>`;
    form.appendChild(row);
  }

  document.getElementById("initiative-modal").classList.remove("hidden");
}

function submitInitiatives() {
  const inputs = document.querySelectorAll("#initiative-form input[data-token-id]");
  const initiatives = {};
  for (const input of inputs) {
    initiatives[input.dataset.tokenId] = parseInt(input.value) || 0;
  }
  document.getElementById("initiative-modal").classList.add("hidden");
  socket.emit("start_combat", { initiatives });
}

function nextTurn() {
  socket.emit("next_turn");
}

function endCombat() {
  socket.emit("end_combat");
}

function setCombatButtonState(inCombat) {
  const nextBtn = document.getElementById("next-turn-btn");
  const endBtn = document.getElementById("end-combat-btn");
  if (nextBtn) nextBtn.disabled = !inCombat;
  if (endBtn) endBtn.disabled = !inCombat;
}

// --- Initiative list ---

function renderInitiative() {
  const list = document.getElementById("initiative-list");
  if (!list) return;
  list.innerHTML = "";

  if (initiativeOrder.length === 0) {
    list.innerHTML = "<div class='init-empty'>No combat</div>";
    return;
  }

  initiativeOrder.forEach((tokenId, index) => {
    const token = sessionTokens[tokenId];
    if (!token) return;

    const hpPct = token.max_hp > 0 ? token.hp / token.max_hp : 1;
    const hpClass = hpPct <= 0.25 ? " low" : hpPct <= 0.6 ? " mid" : "";
    const row = document.createElement("div");
    row.className = "init-entry" + (index === currentTurn ? " active" : "");
    row.innerHTML = `
      <span class="init-num">${token.initiative}</span>
      <span class="init-name">${token.name}</span>
      <span class="init-hp${hpClass}">${token.hp}/${token.max_hp}</span>
    `;
    list.appendChild(row);
  });
}

function updateTurnIndicator(tokenId) {
  const el = document.getElementById("turn-indicator");
  if (!el) return;
  if (!tokenId) {
    el.classList.add("hidden");
    return;
  }
  const token = sessionTokens[tokenId];
  el.textContent = token ? `${token.name}'s turn` : "";
  el.classList.remove("hidden");
}

// --- Dice roller ---

function rollDice() {
  const notation = document.getElementById("dice-notation").value.trim();
  if (!notation) return;
  const privateRoll = document.getElementById("dice-private")?.checked ?? false;
  socket.emit("roll_dice", { notation, private: privateRoll });
}

function quickRoll(notation) {
  document.getElementById("dice-notation").value = notation;
  const privateRoll = document.getElementById("dice-private")?.checked ?? false;
  socket.emit("roll_dice", { notation, private: privateRoll });
}

// --- Chat ---

function sendChat() {
  const input = document.getElementById("chat-input");
  const text = input.value.trim();
  if (!text) return;
  socket.emit("chat_message", { text });
  input.value = "";
}

function appendChat(msg, scroll = true) {
  const log = document.getElementById("chat-log");
  const entry = document.createElement("div");

  if (msg.type === "dice") {
    entry.className = "chat-entry dice-entry" + (msg.private ? " dice-private" : "");
    const rollDetail = msg.rolls.length > 1
      ? ` [${msg.rolls.join(", ")}]${msg.modifier !== 0 ? (msg.modifier > 0 ? `+${msg.modifier}` : msg.modifier) : ""}`
      : "";
    const privateTag = msg.private ? '<span class="dice-private-tag">🔒 </span>' : "";
    entry.innerHTML = `${privateTag}<span class="chat-who">${msg.name}</span> rolled <strong>${msg.notation}</strong>: <strong>${msg.result}</strong><span class="dice-detail">${rollDetail}</span>`;
  } else {
    entry.className = "chat-entry";
    entry.innerHTML = `<span class="chat-who">${msg.name}:</span> ${escapeHtml(msg.text)}`;
  }

  log.appendChild(entry);
  if (scroll) log.scrollTop = log.scrollHeight;
}

function appendSystemMsg(text) {
  const log = document.getElementById("chat-log");
  const entry = document.createElement("div");
  entry.className = "chat-entry";
  entry.textContent = text;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// --- Keyboard shortcuts ---

// --- Token Library ---

function renderLibrary(entries) {
  const list = document.getElementById("library-list");
  if (!list) return;
  if (entries.length === 0) {
    list.innerHTML = '<div class="library-empty">No entries yet. Save a token to start.</div>';
    return;
  }
  list.innerHTML = "";
  for (const entry of entries) {
    const card = document.createElement("div");
    card.className = "library-card";
    card.draggable = true;
    card.dataset.libraryId = entry.id;
    card.innerHTML = `
      <span class="lib-swatch" style="background:${entry.color}"></span>
      <span class="lib-name">${entry.name}</span>
      <span class="lib-hp">HP ${entry.max_hp}</span>
      <button class="lib-delete" onclick="deleteLibraryEntry(${entry.id})" title="Delete">×</button>
    `;
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("library_id", entry.id);
      e.dataTransfer.effectAllowed = "copy";
    });
    list.appendChild(card);
  }
}

function deleteLibraryEntry(id) {
  if (!confirm("Remove this entry from the library?")) return;
  socket.emit("delete_library_entry", { id });
}

function saveCurrentTokenToLibrary() {
  const name = document.getElementById("edit-tok-name")?.value.trim();
  if (!name) return;
  socket.emit("save_to_library", {
    name,
    max_hp:         parseInt(document.getElementById("edit-tok-maxhp")?.value) || 10,
    color:          document.getElementById("edit-tok-color")?.value || "#e74c3c",
    image_url:      document.getElementById("edit-tok-image")?.value.trim() || null,
    size:           parseInt(document.getElementById("edit-tok-size")?.value) || 1,
    initiative_mod: parseInt(document.getElementById("edit-tok-initiative-mod")?.value) || 0,
    show_hp:        document.getElementById("edit-tok-show-hp")?.checked ?? true,
  });
}

// Drag library cards onto the map to spawn tokens
if (ROLE === "dm") {
  const mapContainer = document.getElementById("map-container");
  if (mapContainer) {
    mapContainer.addEventListener("dragover", (e) => {
      if (Array.from(e.dataTransfer.types).includes("library_id")) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    });
    mapContainer.addEventListener("drop", (e) => {
      e.preventDefault();
      const libraryId = e.dataTransfer.getData("library_id");
      if (!libraryId) return;
      const cell = window.clientCoordsToCell?.(e.clientX, e.clientY);
      if (!cell) return;
      socket.emit("spawn_library_token", { library_id: parseInt(libraryId), col: cell.col, row: cell.row });
    });
  }
}

let _clipboard = null; // { type: "tokens", items: [...] } | { type: "spell", shape: {...} }

// Returns the center of a spell shape in grid units
function _spellCenter(shape) {
  switch (shape.type) {
    case "circle": return { col: shape.cx, row: shape.cy };
    case "square": return { col: shape.x + shape.w / 2, row: shape.y + shape.h / 2 };
    case "cone":   return { col: shape.ox, row: shape.oy };
    case "line":   return { col: (shape.x1 + shape.x2) / 2, row: (shape.y1 + shape.y2) / 2 };
    default:       return { col: 0, row: 0 };
  }
}

// Shift a spell shape so its center lands at (col, row)
function _shiftSpell(shape, col, row) {
  const c = _spellCenter(shape);
  const dc = col - c.col, dr = row - c.row;
  const s = { ...shape };
  switch (shape.type) {
    case "circle": s.cx += dc; s.cy += dr; break;
    case "square": s.x  += dc; s.y  += dr; break;
    case "cone":   s.ox += dc; s.oy += dr; s.tx += dc; s.ty += dr; break;
    case "line":   s.x1 += dc; s.y1 += dr; s.x2 += dc; s.y2 += dr; break;
  }
  return s;
}

document.addEventListener("keydown", (e) => {
  // Don't fire shortcuts when typing in an input
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.key === "Home") resetMapView();
  if ((e.key === "Delete" || e.key === "Backspace") && ROLE === "dm") removeSelected();

  // Copy: Ctrl+C
  if (e.ctrlKey && e.key.toLowerCase() === "c") {
    const tokenIds = window.getSelectedTokenIds?.();
    const spellId  = window.getSelectedSpellId?.();
    if (ROLE === "dm" && tokenIds && tokenIds.length > 0) {
      _clipboard = { type: "tokens", items: tokenIds.map(id => ({ ...sessionTokens[id] })).filter(t => t?.id) };
      e.preventDefault();
    } else if (spellId) {
      const shape = window.getSpellData?.(spellId);
      if (shape) { _clipboard = { type: "spell", shape }; e.preventDefault(); }
    }
    return;
  }

  // Paste: Ctrl+V
  if (e.ctrlKey && e.key.toLowerCase() === "v" && _clipboard) {
    e.preventDefault();
    const mouse = window.getLastMouseCell?.() ?? { col: 0, row: 0 };
    if (_clipboard.type === "tokens" && ROLE === "dm") {
      const minCol = Math.min(..._clipboard.items.map(t => t.x));
      const minRow = Math.min(..._clipboard.items.map(t => t.y));
      for (const t of _clipboard.items) {
        socket.emit("add_token", {
          name: t.name, color: t.color, image_url: t.image_url,
          hp: t.hp, max_hp: t.max_hp,
          x: mouse.col + (t.x - minCol),
          y: mouse.row + (t.y - minRow),
          size: t.size, show_hp: t.show_hp, initiative_mod: t.initiative_mod,
        });
      }
    } else if (_clipboard.type === "spell") {
      const shifted = _shiftSpell(_clipboard.shape, mouse.col, mouse.row);
      delete shifted.id; // let server assign a fresh id
      window.socketEmit("add_spell_shape", shifted);
    }
    return;
  }

  // Move selected token with WASD / arrow keys
  const moveKeys = {
    ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
    a: [-1, 0], d: [1, 0], w: [0, -1], s: [0, 1],
  };
  const dir = moveKeys[e.key];
  if (dir) {
    const tid = getSelectedTokenId();
    const token = tid && sessionTokens[tid];
    if (!token) return;
    const canMove = ROLE === "dm" || (window.MY_UUID && token.player_id === window.MY_UUID);
    if (!canMove) return;
    e.preventDefault(); // stop arrow keys from scrolling the page
    const newX = token.x + dir[0];
    const newY = token.y + dir[1];
    token.x = newX;
    token.y = newY;
    updateTokenOnMap(token);
    socket.emit("move_token", { id: tid, x: newX, y: newY });
  }
});

// --- UI helpers ---

function togglePanel(panelId) {
  document.getElementById(panelId).classList.toggle("collapsed");
}

function updatePlayerCount() {
  const count = Object.keys(onlinePlayers).length;
  document.getElementById("player-count").textContent = `${count} online`;
  if (ROLE === "dm") renderOnlinePlayers();
}

function renderOnlinePlayers() {
  const list = document.getElementById("online-players-list");
  if (!list) return;
  list.innerHTML = "";
  const entries = Object.entries(onlinePlayers);
  if (entries.length === 0) {
    list.innerHTML = '<div class="party-empty">No players connected.</div>';
    return;
  }
  for (const [sid, player] of entries) {
    const row = document.createElement("div");
    row.className = "online-player-row";
    const nameSpan = document.createElement("span");
    nameSpan.className = "online-player-name";
    nameSpan.textContent = player.name;
    row.appendChild(nameSpan);
    const btn = document.createElement("button");
    btn.className = "btn-make-dm";
    btn.textContent = "Make DM";
    btn.onclick = () => transferDm(sid, player.name);
    row.appendChild(btn);
    list.appendChild(row);
  }
}

function transferDm(targetSid, targetName) {
  if (!confirm(`Transfer DM control to ${targetName}? You will become a regular player.`)) return;
  socket.emit("transfer_dm", { target_sid: targetSid });
}

socket.on("dm_transferred", (data) => {
  const { new_dm_sid, old_dm_sid, new_dm_name, old_dm_name, promo_token, demo_token } = data;
  const code = document.body.dataset.code;

  if (window.MY_SID === new_dm_sid) {
    // Claim DM role via server, then reload into full DM view
    window.location.href = `/session/${code}/accept_role?token=${promo_token}`;
  } else if (window.MY_SID === old_dm_sid) {
    // Drop to player role via server, then reload into player view
    window.location.href = `/session/${code}/accept_role?token=${demo_token}`;
  } else {
    // Bystander: new DM leaves player list, old DM appears as player
    delete onlinePlayers[new_dm_sid];
    onlinePlayers[old_dm_sid] = { name: old_dm_name, uuid: null };
    updatePlayerCount();
  }
});

// Collapse both panels by default on small screens
if (window.innerWidth <= 640) {
  document.getElementById("char-panel")?.classList.add("collapsed");
  document.getElementById("right-panel")?.classList.add("collapsed");
}
