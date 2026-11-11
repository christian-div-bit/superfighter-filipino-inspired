/*
BACKEND  —  embedded server + "game.db"
   -------------------------------------------------------------------------
   A tiny in-page Express-style router with a persistent JSON store
   (localStorage key: game.db). If a real backend answers at API_BASE,
   the client switches to it automatically, otherwise it falls back here.
   =========================================================================
*/
const DB_KEY = "game.db";
const API_BASES = [
  window.location.origin,
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:3003",
  "http://localhost:3004",
  "http://localhost:5500",
].filter((base, index, bases) => base && bases.indexOf(base) === index);
let API_BASE = API_BASES[0];

// Loads the saved local game state from browser storage and creates a default save if nothing has been stored yet.
function loadDB() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return {
    meta: { version: 1, created: Date.now() },
    players: [],
    scores: [],
  };
}

// Counts down to the next random loot drop and spawns a new pickup when the timer expires.
function updateRandomPickupDrops() {
  if (state.randomDropFrames > 0) {
    state.randomDropFrames--;
    return;
  }
  if (pickups.length < 6) spawnRandomPickupDrop();
  state.randomDropFrames = Math.round(rand(12 * 60, 18 * 60));
}
// Saves the current game data back to localStorage so progress survives a browser refresh.
function persistDB(db) {
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  } catch (e) {}
}

const LocalServer = {
  db: loadDB(),
  // Handles simulated API requests in the browser when no real backend is available so the game still supports leaderboard actions.
  async handle(method, path, body) {
    // simulate network latency so the UI states are honest
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 90));
    const url = new URL(path, "http://localhost");
    const p = url.pathname;

    if (method === "GET" && p === "/api/stats") {
      const s = this.db.scores;
      return {
        ok: true,
        data: {
          games: s.length,
          players: this.db.players.length,
          best: s.length ? Math.max(...s.map((r) => r.score)) : 0,
        },
      };
    }
    if (method === "GET" && p === "/api/scores") {
      const limit = Math.min(50, Number(url.searchParams.get("limit") || 10));
      const rows = [...this.db.scores]
        .sort((a, b) => b.score - a.score || a.createdAt - b.createdAt)
        .slice(0, limit);
      return { ok: true, data: rows };
    }
    if (method === "POST" && p === "/api/scores") {
      const { name, score, wave } = body || {};
      if (typeof score !== "number" || !isFinite(score) || score < 0)
        return { ok: false, error: "invalid score" };
      const clean = String(name || "")
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9 _.-]/g, "")
        .slice(0, 14);
      if (!clean) return { ok: false, error: "name is required" };
      let player = this.db.players.find((pl) => pl.name === clean);
      if (!player) {
        player = {
          id: this.db.players.length + 1,
          name: clean,
          createdAt: Date.now(),
        };
        this.db.players.push(player);
      }
      const existing = this.db.scores.find((row) => row.playerId === player.id);
      if (existing) {
        const normalizedScore = Math.floor(score);
        const updated = normalizedScore > existing.score;
        if (updated) {
          existing.score = normalizedScore;
          existing.wave = Math.floor(wave) || 1;
          existing.createdAt = Date.now();
          persistDB(this.db);
        }
        const rank =
          [...this.db.scores]
            .sort((a, b) => b.score - a.score || a.createdAt - b.createdAt)
            .findIndex((row) => row.id === existing.id) + 1;
        return {
          ok: true,
          data: {
            ...existing,
            rank,
            total: this.db.scores.length,
            existing: true,
            updated,
          },
        };
      }
      const row = {
        id: this.db.scores.length + 1,
        playerId: player.id,
        name: clean,
        score: Math.floor(score),
        wave: Math.floor(wave) || 1,
        createdAt: Date.now(),
      };
      this.db.scores.push(row);
      if (this.db.scores.length > 600) {
        this.db.scores.sort((a, b) => b.score - a.score);
        this.db.scores = this.db.scores.slice(0, 400);
      }
      persistDB(this.db);
      const rank =
        [...this.db.scores]
          .sort((a, b) => b.score - a.score)
          .findIndex((r) => r.id === row.id) + 1;
      return {
        ok: true,
        data: { ...row, rank, total: this.db.scores.length },
      };
    }
    return { ok: false, error: "404 not found" };
  },
};

let useRealServer = false;
// Routes API calls to the real backend when available and falls back to the local in-browser server otherwise.
async function api(method, path, body) {
  if (useRealServer) {
    try {
      const res = await fetch(API_BASE + path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.ok) return await res.json();
    } catch (e) {
      useRealServer = false;
      setBadge(false);
    }
  }
  return LocalServer.handle(method, path, body);
}
// Checks common local server ports to find the live backend and enable online mode automatically.
async function probeServer() {
  for (const base of API_BASES) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 1500);
      const r = await fetch(base + "/api/stats", {
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (r.ok) {
        API_BASE = base;
        useRealServer = true;
        setBadge(true);
        return;
      }
    } catch (e) {}
  }
  API_BASE = API_BASES[0];
  useRealServer = false;
  setBadge(false);
}

/* =========================================================================
   GAME CONSTANTS
   ========================================================================= */
const WORLD = { w: 7200, h: 1080 };
const MAX_WAVES = 50;
const BOSS_WAVE_INTERVAL = 5;
let GROUND_Y = 880;
const GRAVITY = 0.78;
const MOVE_SPEED = 3.6;
const JUMP_VEL = -16.4;

const WEAPONS = {
  pistol: {
    name: "PISTOL",
    image: "pistol.jpg",
    dmg: 16,
    mag: 12,
    rate: 230,
    spread: 0.02,
    speed: 15,
    auto: false,
    pellets: 1,
    reload: 1000,
    kick: 2.0,
    color: "#ffd166",
    len: 18,
    icon: "▬",
  },
  smg: {
    name: "SMG",
    image: "submachinegun.jpg",
    dmg: 9,
    mag: 32,
    rate: 78,
    spread: 0.07,
    speed: 16,
    auto: true,
    pellets: 1,
    reload: 1400,
    kick: 1.3,
    color: "#8ef6ff",
    len: 20,
    icon: "≡",
  },
  shotgun: {
    name: "SHOTGUN",
    image: "shotgun.jpg",
    dmg: 11,
    mag: 6,
    rate: 720,
    spread: 0.14,
    speed: 13,
    auto: false,
    pellets: 7,
    reload: 1800,
    kick: 6.0,
    color: "#ff9f45",
    len: 24,
    icon: "★",
  },
  rifle: {
    name: "RIFLE",
    image: "rifle.jpg",
    dmg: 27,
    mag: 10,
    rate: 430,
    spread: 0.02,
    speed: 20,
    auto: false,
    pellets: 1,
    reload: 1500,
    kick: 4.0,
    color: "#c6ff7a",
    len: 28,
    icon: "⌐",
  },
};

const weaponImages = {};
for (const [key, weapon] of Object.entries(WEAPONS)) {
  const image = new Image();
  image.src = weapon.image;
  weaponImages[key] = image;
}

const CHARACTER_OPTIONS = [
  {
    id: "constructionworker",
    file: "constructionworker.png",
    label: "CONSTRUCTION WORKER",
  },
  { id: "dancer", file: "dancer.png", label: "DANCER" },
  { id: "driver", file: "driver.png", label: "DRIVER" },
  { id: "farmer", file: "farmer.png", label: "FARMER" },
  { id: "police", file: "police.png", label: "POLICE" },
  { id: "tanod", file: "tanod.png", label: "TANOD" },
  { id: "warrior", file: "warrior.png", label: "WARRIOR" },
  {
    id: "bato",
    file: "bato.png",
    label: "BATO",
    reverseFacing: true,
    scale: 1.25,
  },
  {
    id: "duterte",
    file: "duterte.png",
    label: "DUTERTE",
    reverseFacing: true,
    scale: 1.25,
  },
  {
    id: "vp",
    file: "vp.png",
    label: "VP",
    reverseFacing: true,
    scale: 1.25,
  },
];

// Strips the solid background from a sprite image so the character can be drawn with transparency.
function removeCharacterBackground(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  const count = canvas.width * canvas.height;
  const visited = new Uint8Array(count);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;

  // Queues a background image load for a given sprite index so assets are preloaded without stalling gameplay.
  const enqueueBackground = (index) => {
    if (visited[index]) return;
    const offset = index * 4;
    if (
      Math.abs(pixels[offset] - 38) > 18 ||
      Math.abs(pixels[offset + 1] - 38) > 18 ||
      Math.abs(pixels[offset + 2] - 38) > 18
    ) {
      return;
    }
    visited[index] = 1;
    queue[tail++] = index;
  };

  for (let x = 0; x < canvas.width; x++) {
    enqueueBackground(x);
    enqueueBackground((canvas.height - 1) * canvas.width + x);
  }
  for (let y = 0; y < canvas.height; y++) {
    enqueueBackground(y * canvas.width);
    enqueueBackground(y * canvas.width + canvas.width - 1);
  }

  while (head < tail) {
    const index = queue[head++];
    pixels[index * 4 + 3] = 0;
    const x = index % canvas.width;
    if (x > 0) enqueueBackground(index - 1);
    if (x + 1 < canvas.width) enqueueBackground(index + 1);
    if (index >= canvas.width) enqueueBackground(index - canvas.width);
    if (index + canvas.width < count) enqueueBackground(index + canvas.width);
  }

  context.putImageData(imageData, 0, 0);
  return canvas;
}

const characterImages = {};
for (const character of CHARACTER_OPTIONS) {
  const image = new Image();
  image.onload = () => {
    characterImages[character.id] = removeCharacterBackground(image);
  };
  image.src = character.file;
}

const bossImageFiles = [
  "wave 1.png",
  "wave 2.png",
  "wave 3.png",
  "wave 4.png",
  "wave 5.png",
  "wwave 6.png",
  "wave 8.png",
  "wave 8.png",
  "wave 9.png",
  "wave 10.png",
];
const bossImages = bossImageFiles.map((file) => {
  const image = new Image();
  image.src = file;
  return image;
});

let selectedCharacter = CHARACTER_OPTIONS[0].id;
let selectedP2Character = "dancer";
try {
  const savedCharacter = localStorage.getItem("sf.character");
  if (CHARACTER_OPTIONS.some((character) => character.id === savedCharacter)) {
    selectedCharacter = savedCharacter;
  }
  const savedP2Character = localStorage.getItem("sf.character.p2");
  if (
    CHARACTER_OPTIONS.some((character) => character.id === savedP2Character)
  ) {
    selectedP2Character = savedP2Character;
  }
} catch (e) {}
const bambooImage = new Image();
bambooImage.src = "Stacked Green Bamboo Poles.png";
const mapBackgrounds = {
  map1: new Image(),
  map2: new Image(),
};
mapBackgrounds.map1.src = "map 1.jpg";
mapBackgrounds.map2.src = "map 2.png";

const PLATFORMS = [
  { x: 0, y: GROUND_Y, w: WORLD.w, h: 200, kind: "ground" },
  { x: 0, y: 730, w: 420, h: 34, kind: "ledge" },
  { x: 560, y: 730, w: 400, h: 34, kind: "ledge" },
  { x: 1100, y: 730, w: 520, h: 34, kind: "ledge" },
  { x: 1740, y: 730, w: 660, h: 34, kind: "ledge" },
  { x: 140, y: 580, w: 420, h: 34, kind: "ledge" },
  { x: 700, y: 580, w: 420, h: 34, kind: "ledge" },
  { x: 1260, y: 580, w: 440, h: 34, kind: "ledge" },
  { x: 1860, y: 580, w: 540, h: 34, kind: "ledge" },
  { x: 320, y: 430, w: 420, h: 34, kind: "ledge" },
  { x: 940, y: 430, w: 520, h: 34, kind: "ledge" },
  { x: 1700, y: 430, w: 620, h: 34, kind: "ledge" },
];

const LADDERS = [
  { x: 300, top: 730, bot: GROUND_Y },
  { x: 1300, top: 730, bot: GROUND_Y },
  { x: 2000, top: 730, bot: GROUND_Y },
  { x: 300, top: 580, bot: 730 },
  { x: 800, top: 580, bot: 730 },
  { x: 1400, top: 580, bot: 730 },
  { x: 2000, top: 580, bot: 730 },
  { x: 440, top: 430, bot: 580 },
  { x: 1020, top: 430, bot: 580 },
  { x: 1360, top: 430, bot: 580 },
];

const SIGNS = [
  {
    x: 80,
    y: 612,
    w: 186,
    h: 78,
    lines: ["SARI-SARI", "STORE"],
    bg: "#e6dcbe",
    fg: "#2b2115",
    accent: "#c0392b",
    size: 11,
  },
  {
    x: 600,
    y: 470,
    w: 196,
    h: 80,
    lines: ["PINOY TAYO", "LAGI"],
    bg: "#e9eef5",
    fg: "#1c2432",
    accent: "#1d4ed8",
    size: 11,
    flag: true,
  },
  {
    x: 1140,
    y: 322,
    w: 250,
    h: 78,
    lines: ["LABAN", "PILIPINAS"],
    bg: "#1b3fa0",
    fg: "#ffe9a8",
    accent: "#c8102e",
    size: 13,
    flag: true,
  },
  {
    x: 1560,
    y: 630,
    w: 200,
    h: 80,
    lines: ["TULOY ANG", "LABAN"],
    bg: "#cfd6de",
    fg: "#242b38",
    accent: "#c8102e",
    size: 11,
    graffiti: true,
  },
  {
    x: 240,
    y: 796,
    w: 216,
    h: 74,
    lines: ["BAWAL", "MAGTAPON", "NG BASURA"],
    bg: "#d9c9a3",
    fg: "#3a2a17",
    accent: "#8a1f1f",
    size: 9,
  },
];

const LAMPS = [
  { x: 150, y: 700 },
  { x: 520, y: 690 },
  { x: 900, y: 755 },
  { x: 1250, y: 660 },
  { x: 1520, y: 700 },
  { x: 1840, y: 650 },
  { x: 2140, y: 700 },
  { x: 690, y: 455 },
  { x: 1200, y: 420 },
  { x: 1900, y: 420 },
  { x: 430, y: 560 },
  { x: 1620, y: 560 },
];

const PROPS = [
  { t: "jeepney", x: 70, y: GROUND_Y },
  { t: "crate", x: 470, y: GROUND_Y },
  { t: "crate", x: 506, y: GROUND_Y - 30 },
  { t: "barrel", x: 640, y: GROUND_Y, c: "#b5322f" },
  { t: "crate", x: 1180, y: GROUND_Y },
  { t: "plant", x: 1240, y: GROUND_Y },
  { t: "barrel", x: 1500, y: GROUND_Y, c: "#2f7d4f" },
  { t: "crate", x: 1820, y: GROUND_Y },
  { t: "crate", x: 1856, y: GROUND_Y - 30 },
  { t: "barrel", x: 2100, y: GROUND_Y, c: "#b5322f" },
  { t: "plant", x: 2300, y: GROUND_Y },
  { t: "crate", x: 120, y: 730 },
  { t: "plant", x: 250, y: 730 },
  { t: "barrel", x: 640, y: 730, c: "#b5322f" },
  { t: "crate", x: 860, y: 730 },
  { t: "crate", x: 1180, y: 730 },
  { t: "chair", x: 1300, y: 730 },
  { t: "barrel", x: 1820, y: 730, c: "#2f7d4f" },
  { t: "crate", x: 2040, y: 730 },
  { t: "plant", x: 300, y: 580 },
  { t: "crate", x: 520, y: 580 },
  { t: "chair", x: 860, y: 580 },
  { t: "barrel", x: 1020, y: 580, c: "#b5322f" },
  { t: "crate", x: 1400, y: 580 },
  { t: "plant", x: 1560, y: 580 },
  { t: "crate", x: 1960, y: 580 },
  { t: "barrel", x: 2160, y: 580, c: "#2f7d4f" },
  { t: "plant", x: 420, y: 430 },
  { t: "crate", x: 640, y: 430 },
  { t: "chair", x: 1060, y: 430 },
  { t: "crate", x: 1280, y: 430 },
  { t: "plant", x: 1820, y: 430 },
  { t: "barrel", x: 2040, y: 430, c: "#b5322f" },
];

const basePlatforms = PLATFORMS.filter((item) => item.kind === "ledge");
const baseLadders = [...LADDERS];
const baseSigns = [...SIGNS];
const baseLamps = [...LAMPS];
const baseProps = [...PROPS];

for (const offset of [2400, 4800]) {
  for (const platform of basePlatforms) {
    PLATFORMS.push({ ...platform, x: platform.x + offset });
  }
  for (const ladder of baseLadders) {
    LADDERS.push({ ...ladder, x: ladder.x + offset });
  }
  for (const sign of baseSigns) SIGNS.push({ ...sign, x: sign.x + offset });
  for (const lamp of baseLamps) LAMPS.push({ ...lamp, x: lamp.x + offset });
  for (const prop of baseProps) PROPS.push({ ...prop, x: prop.x + offset });
}

const originalMap3Geometry = {
  platforms: PLATFORMS.filter((platform) => platform.kind === "ledge").map(
    (platform) => ({ ...platform }),
  ),
  ladders: LADDERS.map((ladder) => ({ ...ladder })),
  signs: SIGNS.map((sign) => ({ ...sign })),
  lamps: LAMPS.map((lamp) => ({ ...lamp })),
  props: PROPS.map((prop) => ({ ...prop })),
};
const MAP_LAYOUTS = {
  map1: {
    groundY: 770,
    platforms: [
      { x: 225, y: 220, w: 765, h: 34 },
      { x: 1240, y: 220, w: 765, h: 34 },
      { x: 2255, y: 220, w: 145, h: 34 },
      { x: 0, y: 485, w: 740, h: 34 },
      { x: 985, y: 485, w: 720, h: 34 },
      { x: 1975, y: 485, w: 425, h: 34 },
    ],
    ladders: [
      { x: 520, top: 220, bot: 485 },
      { x: 1425, top: 220, bot: 485 },
      { x: 2320, top: 220, bot: 485 },
      { x: 520, top: 485, bot: 770 },
      { x: 2320, top: 485, bot: 770 },
    ],
  },
  map2: {
    groundY: 960,
    platforms: [
      { x: 0, y: 265, w: 2400, h: 34 },
      { x: 0, y: 525, w: 650, h: 34 },
      { x: 765, y: 525, w: 590, h: 34 },
      { x: 1410, y: 525, w: 510, h: 34 },
      { x: 2060, y: 525, w: 340, h: 34 },
      { x: 620, y: 810, w: 700, h: 34 },
    ],
    ladders: [
      { x: 520, top: 265, bot: 525 },
      { x: 1180, top: 265, bot: 525 },
      { x: 1860, top: 265, bot: 525 },
      { x: 1230, top: 525, bot: 810 },
    ],
  },
};
let selectedMapId = "map3";
try {
  const savedMapId = localStorage.getItem("sf.map");
  if (savedMapId === "map1" || savedMapId === "map2" || savedMapId === "map3") {
    selectedMapId = savedMapId;
  }
} catch (e) {}

// Applies the selected map layout and refreshes the world to match the player choice.
function applySelectedMap() {
  if (selectedMapId === "map3") {
    GROUND_Y = 880;
    PLATFORMS.splice(
      0,
      PLATFORMS.length,
      { x: 0, y: GROUND_Y, w: WORLD.w, h: 200, kind: "ground" },
      ...originalMap3Geometry.platforms.map((platform) => ({ ...platform })),
    );
    LADDERS.splice(
      0,
      LADDERS.length,
      ...originalMap3Geometry.ladders.map((ladder) => ({ ...ladder })),
    );
    SIGNS.splice(
      0,
      SIGNS.length,
      ...originalMap3Geometry.signs.map((sign) => ({ ...sign })),
    );
    LAMPS.splice(
      0,
      LAMPS.length,
      ...originalMap3Geometry.lamps.map((lamp) => ({ ...lamp })),
    );
    PROPS.splice(
      0,
      PROPS.length,
      ...originalMap3Geometry.props.map((prop) => ({ ...prop })),
    );
    return;
  }

  const layout = MAP_LAYOUTS[selectedMapId];
  GROUND_Y = layout.groundY;
  const platforms = [];
  const ladders = [];
  for (const offset of [0, 2400, 4800]) {
    platforms.push(
      ...layout.platforms.map((platform) => ({
        ...platform,
        x: platform.x + offset,
        kind: "ledge",
      })),
    );
    ladders.push(
      ...layout.ladders.map((ladder) => ({
        ...ladder,
        x: ladder.x + offset,
      })),
    );
  }
  PLATFORMS.splice(
    0,
    PLATFORMS.length,
    { x: 0, y: GROUND_Y, w: WORLD.w, h: WORLD.h - GROUND_Y, kind: "ground" },
    ...platforms,
  );
  LADDERS.splice(0, LADDERS.length, ...ladders);
  SIGNS.length = 0;
  LAMPS.length = 0;
  PROPS.length = 0;
}

/* =========================================================================
   CANVAS / VIEW
   ========================================================================= */
const cvs = document.getElementById("game");
const ctx = cvs.getContext("2d");
let VW = 0,
  VH = 0,
  DPR = 1,
  scale = 1,
  baseScale = 1;
const cam = { x: 0, y: 0 };
let orientationPaused = false;

// Returns whether the current viewport is in landscape orientation so the UI can respond to device rotation.
function isLandscape() {
  return VW >= VH;
}

// Recalculates the canvas scale and layout based on the device orientation and viewport size.
function updateOrientation() {
  const landscape = isLandscape();
  document.documentElement.classList.toggle("portrait", !landscape);
}

// Resizes the game canvas and UI to fit the current browser window or device screen.
function resize() {
  const viewport = window.visualViewport;
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  VW = Math.floor(viewport ? viewport.width : window.innerWidth);
  VH = Math.floor(viewport ? viewport.height : window.innerHeight);
  document.documentElement.style.setProperty("--app-height", VH + "px");
  cvs.width = Math.floor(VW * DPR);
  cvs.height = Math.floor(VH * DPR);
  cvs.style.width = VW + "px";
  cvs.style.height = VH + "px";
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.imageSmoothingEnabled = false;
  baseScale = VW < VH ? VW / 520 : VH / 640;
  baseScale = Math.max(0.5, Math.min(1.7, baseScale));
  scale = baseScale;
  updateOrientation();
}
window.addEventListener("resize", resize);
window.addEventListener("orientationchange", () => setTimeout(resize, 200));
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", resize);
}
resize();

// Converts world width to the current viewport width for camera and drawing calculations.
const viewW = () => VW / scale;
// Converts world height to the current viewport height so scene rendering stays scaled correctly.
const viewH = () => VH / scale;

// Keeps the camera centered on the target and optionally snaps it instantly during major scene changes.
function camFollow(target, snap) {
  let tx = target.x + target.w / 2 - viewW() / 2;
  let ty = target.y + target.h / 2 - viewH() / 2;
  const maxX = Math.max(0, WORLD.w - viewW());
  const maxY = Math.max(0, WORLD.h - viewH());
  tx = Math.max(0, Math.min(maxX, tx));
  ty = Math.max(-80, Math.min(maxY, ty));
  if (viewW() > WORLD.w) tx = (WORLD.w - viewW()) / 2;
  if (viewH() > WORLD.h) ty = (WORLD.h - viewH()) / 2;
  if (snap) {
    cam.x = tx;
    cam.y = ty;
  } else {
    cam.x += (tx - cam.x) * 0.12;
    cam.y += (ty - cam.y) * 0.1;
  }
}

// Duel camera zoom keeps both fighters in frame during close-range battles by tightening the view as the fighter separate in the end.
function updateDuelCameraZoom() {
  let targetScale = baseScale;
  if (state.gameMode === "duel" && player?.alive && secondPlayer?.alive) {
    const separationX = Math.abs(
      player.x + player.w / 2 - (secondPlayer.x + secondPlayer.w / 2),
    );
    const separationY = Math.abs(
      player.y + player.h / 2 - (secondPlayer.y + secondPlayer.h / 2),
    );
    const horizontalFit = (VW - 160) / (separationX + player.w + 160);
    const verticalFit = (VH - 220) / (separationY + player.h + 160);
    targetScale = Math.min(baseScale, horizontalFit, verticalFit);
    targetScale = Math.max(0.08, targetScale);
  }
  scale += (targetScale - scale) * 0.12;
}

/* =========================================================================
   GAME STATE 
   ========================================================================= */
const state = {
  scene: "menu",
  gameMode: "single",
  time: 0,
  score: 0,
  wave: 0,
  kills: 0,
  shots: 0,
  hits: 0,
  shake: 0,
  remaining: 0,
  spawnCd: 0,
  waveBreak: 0,
  bossSpawned: false,
  duelEndScheduled: false,
  duelTimeFrames: 0,
  p1Kills: 0,
  p2Kills: 0,
  p1RespawnFrames: 0,
  p2RespawnFrames: 0,
  randomDropFrames: 0,
  maxAlive: 3,
  sound: true,
};
let player = null;
let secondPlayer = null;
let p2PlayerName = "PLAYER 2";
const enemies = [],
  bullets = [],
  particles = [],
  pickups = [],
  grenades = [],
  gasClouds = [],
  proxyMines = [],
  floaters = [];
const GRENADE_TYPES = ["frag", "gas", "mine"];
const GRENADE_LABELS = {
  frag: "FRAG",
  gas: "GAS",
  mine: "PROXY MINE",
};
const keys = {};
const mouse = { x: VW / 2, y: VH / 2, down: false, active: false };

/* =========================================================================
   AUDIO — tiny synth, no external files
   ========================================================================= */
let AC = null;
// Audio setup lazy-loads the browser sound engine so the game can play shot, hit, pickup, and wave sounds only when the user starts playing.
function audio() {
  if (!AC) {
    try {
      AC = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {}
  }
  return AC;
}
// Plays a short sound effect for UI and combat events such as shots, hits, and pickups.
function sfx(type) {
  if (!state.sound) return;
  const a = audio();
  if (!a) return;
  if (a.state === "suspended") a.resume();
  const t = a.currentTime;
  const o = a.createOscillator(),
    g = a.createGain();
  o.connect(g);
  g.connect(a.destination);
  const P = {
    shot: { f: 520, f2: 80, d: 0.09, v: 0.1, type: "square" },
    boom: { f: 160, f2: 30, d: 0.45, v: 0.22, type: "sawtooth" },
    hit: { f: 300, f2: 120, d: 0.08, v: 0.1, type: "square" },
    reload: { f: 900, f2: 400, d: 0.08, v: 0.06, type: "triangle" },
    pickup: { f: 600, f2: 1200, d: 0.14, v: 0.1, type: "triangle" },
    hurt: { f: 220, f2: 70, d: 0.22, v: 0.14, type: "sawtooth" },
    wave: { f: 400, f2: 900, d: 0.35, v: 0.12, type: "square" },
  }[type];
  if (!P) return;
  o.type = P.type;
  o.frequency.setValueAtTime(P.f, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, P.f2), t + P.d);
  g.gain.setValueAtTime(P.v, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + P.d);
  o.start(t);
  o.stop(t + P.d + 0.02);
}

/* =========================================================================
   ENTITY HELPERS
   ========================================================================= */
// Tests whether two rectangles overlap to simplify collision checks for players, enemies, and props.
function aabb(a, b) {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}
// Returns a random value within a range for enemy behavior, pickups, and battlefield variation.
function rand(a, b) {
  return a + Math.random() * (b - a);
}
// Keeps a number inside a minimum and maximum range to avoid invalid positions or damage values.
function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

// Constructs a fighter object with shared stats, position, controls, and combat state for either the player or an enemy.
function makeFighter(x, y, isPlayer) {
  return {
    x,
    y,
    w: 26,
    h: 44,
    vx: 0,
    vy: 0,
    onGround: false,
    facing: 1,
    aim: 0,
    hp: isPlayer ? 180 : 100,
    maxHp: isPlayer ? 180 : 100,
    alive: true,
    hitT: 0,
    muzzle: 0,
    walkT: 0,
    weapon: "pistol",
    mag: 12,
    secondaryWeapon: null,
    secondaryMag: 0,
    fireCd: 0,
    reloading: false,
    reloadT: 0,
    firedPress: false,
    grenadeInventory: { frag: 0, gas: 0, mine: 0 },
    grenadeType: "frag",
    meleeCd: 0,
    climbing: false,
    ladder: null,
    isPlayer: !!isPlayer,
    colors: isPlayer
      ? {
          skin: "#e3b183",
          shirt: "#2f6fd0",
          pants: "#1d2b4a",
          hair: "#141a2c",
          acc: "#ffd166",
        }
      : {
          skin: "#c79567",
          shirt: "#a3232b",
          pants: "#2c2130",
          hair: "#101018",
          acc: "#ff6b6b",
        },
    score: 0,
  };
}
// Creates the player fighter with the selected character, weapon state, input bindings, and movement data.
function makePlayer(
  x,
  y,
  character = selectedCharacter,
  isPlayer2 = false,
  playerName,
) {
  const p = makeFighter(x, y, true);
  p.grenadeInventory.frag = 2;
  p.character = character;
  p.isPlayer2 = isPlayer2;
  p.playerName =
    playerName || (isPlayer2 ? p2PlayerName : state.playerName || "PLAYER 1");
  return p;
}
// Builds an enemy fighter with patrol, attack, and spawn data so the battleground stays populated.
function makeEnemy(x, y) {
  const e = makeFighter(x, y, false);
  const keys = ["pistol", "smg", "shotgun", "rifle"];
  e.weapon = keys[(Math.random() * keys.length) | 0];
  e.mag = WEAPONS[e.weapon].mag;
  e.hp = e.maxHp = 30 + state.wave * 5;
  e.damageMultiplier = 1 + state.wave * 0.015;
  e.vx = 0;
  return e;
}
// Creates the boss encounter with more health, stronger attacks, and special behaviors.
function makeBoss() {
  const spawn = randomEnemySpawnPoint();
  const boss = makeEnemy(spawn.x, spawn.y);
  boss.isBoss = true;
  boss.bossImage = bossImages[(state.wave - 1) % bossImages.length];
  boss.w = 64 + Math.min(state.wave, 10) * 2;
  boss.h = 104 + Math.min(state.wave, 10) * 5;
  boss.bossDrawH = 150 + Math.min(state.wave, 10) * 6;
  boss.y += 44 - boss.h;
  boss.hp = boss.maxHp = 300 + state.wave * 60;
  boss.damageMultiplier = 1.3 + state.wave * 0.025;
  boss.weapon = "rifle";
  boss.mag = WEAPONS[boss.weapon].mag;
  return boss;
}

/* =========================================================================
   PHYSICS
   ========================================================================= */
// Resolves horizontal collision against the level geometry and prevents fighters from walking through walls.
function collideX(f) {
  for (const s of PLATFORMS) {
    if (!aabb(f, s)) continue;
    if (f.vx > 0) {
      f.x = s.x - f.w;
    } else if (f.vx < 0) {
      f.x = s.x + s.w;
    }
    f.vx = 0;
  }
  f.x = clamp(f.x, 0, WORLD.w - f.w);
}
// Resolves vertical collision to keep the fighter grounded and prevent overlap with platforms and scenery.
function collideY(f) {
  f.onGround = false;
  for (const s of PLATFORMS) {
    if (!aabb(f, s)) continue;
    if (f.vy > 0) {
      f.y = s.y - f.h;
      f.vy = 0;
      f.onGround = true;
    } else if (f.vy < 0) {
      f.y = s.y + s.h;
      f.vy = 0.5;
    }
  }
}
// Looks up the ladder beneath or near a fighter so climbing logic can activate correctly.
function ladderAt(f) {
  const cx = f.x + f.w / 2;
  const head = f.y;
  const feet = f.y + f.h;
  for (const L of LADDERS) {
    if (
      cx > L.x - 26 &&
      cx < L.x + 26 &&
      head < L.bot &&
      feet >= L.top - 4 &&
      feet <= L.bot + 10
    )
      return L;
  }
  return null;
}

/* =========================================================================
   COMBAT
   ========================================================================= */
// Begins the weapon reload sequence and updates the fighter state to block shooting until ammo is refilled.
function startReload(f) {
  if (f.reloading || !f.alive) return;
  const w = WEAPONS[f.weapon];
  if (f.mag >= w.mag) return;
  f.reloading = true;
  f.reloadT = Math.round((w.reload / 1000) * 60);
  if (f.isPlayer) sfx("reload");
}

// Fires the current weapon, consumes ammo, and creates bullet traces or pellets for the shot.
function fireWeapon(f) {
  if (!f.alive || f.reloading || f.fireCd > 0) return;
  const w = WEAPONS[f.weapon];
  if (f.mag <= 0) {
    startReload(f);
    return;
  }
  f.mag--;
  f.fireCd = Math.round((w.rate / 1000) * 60);
  const ox = f.x + f.w / 2,
    oy = f.y + 18;
  for (let i = 0; i < w.pellets; i++) {
    const a = f.aim + (Math.random() - 0.5) * w.spread * 2;
    const sp = w.speed * rand(0.92, 1.08);
    bullets.push({
      x: ox + Math.cos(f.aim) * w.len,
      y: oy + Math.sin(f.aim) * w.len,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      dmg: f.isPlayer
        ? w.dmg
        : Math.ceil(w.dmg * 0.55 * (f.damageMultiplier || 1)),
      owner: f.isPlayer2 ? "player2" : f.isPlayer ? "player" : "enemy",
      attacker: f.isPlayer ? f : null,
      life: 110,
      color: w.color,
    });
  }
  if (f.isPlayer) state.shots += w.pellets;
  f.muzzle = 4;
  f.vx -= Math.cos(f.aim) * w.kick * 0.28;
  if (f.onGround) f.vx *= 0.96;
  for (let i = 0; i < 3; i++) {
    particles.push({
      x: ox + Math.cos(f.aim) * w.len,
      y: oy + Math.sin(f.aim) * w.len,
      vx: Math.cos(f.aim) * rand(1, 3) + rand(-1, 1),
      vy: rand(-2.6, -0.6),
      life: 30,
      max: 30,
      size: 2,
      color: "#ffd166",
      grav: 0.22,
    });
  }
  state.shake = Math.min(state.shake + w.kick * 0.45, 9);
  if (f.isPlayer) sfx("shot");
}

// Launches a grenade from the fighter and adds it to the active projectile list for later explosion logic.
function throwGrenade(f) {
  if (!f || !f.alive) return;
  const type = f.grenadeType;
  if (!f.grenadeInventory[type]) {
    cycleGrenade(f, true);
    if (!f.grenadeInventory[f.grenadeType]) {
      showToast("NO GRENADES");
      return;
    }
  }
  const selectedType = f.grenadeType;
  f.grenadeInventory[selectedType]--;
  if (selectedType === "mine") {
    const x = clamp(f.x + f.w / 2 + f.facing * 30, 8, WORLD.w - 8);
    proxyMines.push({
      x,
      y: f.y + f.h - 4,
      vy: 0,
      armTimer: 30,
      owner: f.isPlayer2 ? "player2" : f.isPlayer ? "player" : "enemy",
      attacker: f.isPlayer ? f : null,
    });
    if (f.grenadeInventory[selectedType] === 0) cycleGrenade(f, true);
    updateHUD();
    sfx("reload");
    return;
  }
  grenades.push({
    x: f.x + f.w / 2,
    y: f.y + 14,
    vx: Math.cos(f.aim) * 9 + f.vx * 0.5,
    vy: Math.sin(f.aim) * 9 - 2.4,
    fuse: selectedType === "gas" ? 42 : 70,
    type: selectedType,
    owner: f.isPlayer2 ? "player2" : f.isPlayer ? "player" : "enemy",
    attacker: f.isPlayer ? f : null,
    r: 6,
    rot: 0,
  });
  if (f.grenadeInventory[selectedType] === 0) cycleGrenade(f, true);
  updateHUD();
  sfx("reload");
}

// Switches the active grenade type or updates the UI without distracting the user during a silent state change.
function cycleGrenade(f, silent = false) {
  if (!f) return;
  const current = GRENADE_TYPES.indexOf(f.grenadeType);
  for (let offset = 1; offset <= GRENADE_TYPES.length; offset++) {
    const type = GRENADE_TYPES[(current + offset) % GRENADE_TYPES.length];
    if (f.grenadeInventory[type] > 0) {
      f.grenadeType = type;
      updateHUD();
      if (!silent) showToast(GRENADE_LABELS[type] + " GRENADE SELECTED");
      return;
    }
  }
  if (!silent) showToast("NO GRENADES");
}

// Finds valid enemy targets for a grenade so explosions can damage nearby threats instead of friend or environment.
function grenadeTargets(owner) {
  if (owner === "player") {
    return state.gameMode === "duel" ? [secondPlayer] : enemies;
  }
  if (owner === "player2") return [player];
  return [player, secondPlayer].filter(Boolean);
}

// Cycles or selects the fighter weapon and updates the on-screen loadout and recoil visuals.
function switchWeapon(f) {
  if (!f || !f.alive) return;
  if (!f.secondaryWeapon) {
    showToast("NO SECONDARY WEAPON");
    return;
  }
  const weapon = f.weapon;
  const mag = f.mag;
  f.weapon = f.secondaryWeapon;
  f.mag = f.secondaryMag;
  f.secondaryWeapon = weapon;
  f.secondaryMag = mag;
  f.reloading = false;
  f.reloadT = 0;
  updateHUD();
}

// Performs a close-range melee strike when the fighter is attacking at point-blank range.
function meleeAttack(f) {
  if (!f || !f.alive || f.meleeCd > 0) return;
  f.meleeCd = 28;
  const targets =
    f.isPlayer && state.gameMode === "duel"
      ? [f.isPlayer2 ? player : secondPlayer]
      : f.isPlayer
        ? enemies
        : [];
  let target = null;
  let closest = 58;
  const fx = f.x + f.w / 2;
  for (const candidate of targets) {
    if (!candidate || !candidate.alive) continue;
    const dx = candidate.x + candidate.w / 2 - fx;
    const dy = Math.abs(candidate.y + candidate.h / 2 - (f.y + f.h / 2));
    if (Math.sign(dx) !== f.facing || dy > 42) continue;
    if (Math.abs(dx) < closest) {
      closest = Math.abs(dx);
      target = candidate;
    }
  }
  if (target) {
    damage(target, 30, fx, f);
    sfx("hit");
  } else {
    sfx("reload");
  }
}

// Triggers the explosion effect and applies damage to fighters and props within the blast radius.
function explode(x, y, radius, power, attacker, owner) {
  sfx("boom");
  state.shake = 15;
  for (let i = 0; i < 34; i++) {
    const a = Math.random() * Math.PI * 2,
      sp = rand(1, 8);
    particles.push({
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp - 1.4,
      life: rand(20, 48),
      max: 48,
      size: rand(2, 5),
      color: ["#ffd166", "#ff8f2e", "#ff4d2e", "#ffe9a8", "#8b6b3a"][
        (Math.random() * 5) | 0
      ],
      grav: 0.18,
    });
  }
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2,
      sp = rand(2, 6);
    particles.push({
      x,
      y,
      vx: Math.cos(a) * sp,
      vy: Math.sin(a) * sp,
      life: rand(30, 70),
      max: 70,
      size: rand(3, 7),
      color: "#3a3f52",
      grav: -0.03,
    });
  }
  for (const f of grenadeTargets(owner)) {
    if (!f || !f.alive) continue;
    const cx = f.x + f.w / 2,
      cy = f.y + f.h / 2;
    const d = Math.hypot(cx - x, cy - y);
    if (d < radius) {
      damage(f, power * (1 - d / radius), x, attacker);
    }
  }
}

// Applies incoming damage, handles knockback, and triggers death logic when a fighter reaches zero health.
function damage(f, amount, fromX, attacker) {
  if (!f.alive || amount <= 0) return;
  amount = Math.round(amount);
  f.hp -= amount;
  f.hitT = 10;
  for (let i = 0; i < 7; i++) {
    particles.push({
      x: f.x + f.w / 2,
      y: f.y + f.h / 2,
      vx:
        rand(-3, 3) + (fromX !== undefined ? Math.sign(f.x - fromX) * 1.5 : 0),
      vy: rand(-3, 1),
      life: rand(18, 34),
      max: 34,
      size: rand(2, 4),
      color: "#c0272d",
      grav: 0.28,
    });
  }
  if (f.isPlayer) {
    state.shake = Math.min(state.shake + 5, 12);
    sfx("hurt");
  } else if (fromX !== undefined) {
    state.hits++;
  }
  if (f.hp <= 0) {
    f.hp = 0;
    f.alive = false;
    onDeath(f, attacker);
  }
  updateHUD();
}

// Handles fighter death by awarding score, spawning drops, and updating the game feed and enemy state.
function onDeath(f, attacker) {
  if (f.isPlayer) {
    if (state.gameMode === "duel") {
      if (attacker && attacker.isPlayer && attacker !== f) {
        if (attacker.isPlayer2) state.p2Kills++;
        else state.p1Kills++;
      }
      if (f.isPlayer2) state.p2RespawnFrames = 90;
      else state.p1RespawnFrames = 90;
      showToast(
        (attacker && attacker.playerName ? attacker.playerName : "FIGHTER") +
          " SCORED!",
      );
      updateHUD();
      return;
    }
    state.scene = "dead";
    for (let i = 0; i < 20; i++) {
      particles.push({
        x: f.x + f.w / 2,
        y: f.y + f.h / 2,
        vx: rand(-5, 5),
        vy: rand(-5, 1),
        life: rand(30, 60),
        max: 60,
        size: rand(2, 5),
        color: "#c0272d",
        grav: 0.3,
      });
    }
    setTimeout(showGameOver, 700);
    return;
  }
  // enemy death
  const gain = f.isBoss ? 100 : 10;
  state.score += gain;
  state.kills++;
  floaters.push({
    x: f.x + f.w / 2,
    y: f.y,
    text: "+" + gain,
    life: 60,
    color: "#ffd166",
  });
  addKillFeed(
    f.isBoss ? "BOSS DEFEATED" : f.weapon ? WEAPONS[f.weapon].name : "FIST",
  );
  sfx("hit");
  // drops
  const roll = Math.random();
  if (roll < 0.24)
    dropPickup(
      f.x + f.w / 2,
      f.y,
      "weapon",
      ["smg", "shotgun", "rifle", "pistol"][(Math.random() * 4) | 0],
    );
  else if (roll < 0.44) dropPickup(f.x + f.w / 2, f.y, "health");
  else if (roll < 0.6)
    dropPickup(
      f.x + f.w / 2,
      f.y,
      "grenade",
      GRENADE_TYPES[(Math.random() * GRENADE_TYPES.length) | 0],
    );
}

// Creates the in-world pickup item that can later be collected by the player; this covers weapons, health packs,
// and grenade drops for the solo run and the duel mode.
function dropPickup(x, y, type, item) {
  if (type === "nade") {
    type = "grenade";
    item = "frag";
  }
  if (
    (type === "weapon" &&
      pickups.filter((pickup) => pickup.type === "weapon").length >= 3) ||
    (type === "grenade" &&
      pickups.filter((pickup) => pickup.type === "grenade").length >= 5) ||
    pickups.length >= 10
  )
    return;
  pickups.push({
    x: x - 14,
    y: y - 10,
    w: 28,
    h: 28,
    type,
    weapon: type === "weapon" ? item : undefined,
    grenadeType: type === "grenade" ? item : undefined,
    bob: Math.random() * 6.28,
    vy: 0,
  });
}

// Adds a kill event to the on-screen feed so players can track combat progress and recent takedowns.
function addKillFeed(weaponName) {
  const el = document.getElementById("killfeed");
  const d = document.createElement("div");
  d.className = "kf pixel";
  d.textContent = "KALABAN DOWN · " + weaponName;
  el.appendChild(d);
  setTimeout(() => d.remove(), 3000);
  while (el.children.length > 4) el.removeChild(el.firstChild);
}

/* =========================================================================
   PICKUPS
   ========================================================================= */
// Seeds the map with starting pickups to give players access to weapons and support items early.
function spawnInitialPickups() {
  pickups.length = 0;
  dropPickup(600, 730, "weapon", "smg");
  dropPickup(1300, 730, "weapon", "shotgun");
  dropPickup(1050, 430, "weapon", "rifle");
  dropPickup(430, 580, "health");
  dropPickup(1900, 580, "health");
  dropPickup(200, GROUND_Y, "grenade", "gas");
  dropPickup(2200, GROUND_Y, "grenade", "mine");
}

// Finds the closest available pickup so the fighter can auto-collect or aim toward it.
function nearestPickup(fighter = player) {
  if (!fighter || !fighter.alive) return null;
  let best = null,
    bd = 62;
  const cx = fighter.x + fighter.w / 2,
    cy = fighter.y + fighter.h / 2;
  for (const p of pickups) {
    const d = Math.hypot(p.x + p.w / 2 - cx, p.y + p.h / 2 - cy);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return best;
}

// Pickup logic checks the nearest loot item, removes it from the map, and applies its effect to health, ammo,
// or grenade inventory. This is the code behind health packs, new weapons, and grenade drops.
function tryPickup(fighter = player) {
  const pickup = nearestPickup(fighter);
  if (!pickup || !fighter.alive) return;
  const i = pickups.indexOf(pickup);
  if (i >= 0) pickups.splice(i, 1);
  sfx("pickup");
  if (pickup.type === "weapon") {
    fighter.secondaryWeapon = fighter.weapon;
    fighter.secondaryMag = fighter.mag;
    fighter.weapon = pickup.weapon;
    fighter.mag = WEAPONS[pickup.weapon].mag;
    fighter.reloading = false;
    showToast(fighter.playerName + " PICKED UP " + WEAPONS[pickup.weapon].name);
  } else if (pickup.type === "health") {
    fighter.hp = Math.min(fighter.maxHp, fighter.hp + 35);
    showToast(fighter.playerName + " PICKED UP HEALTH (+35 HP)");
  } else if (pickup.type === "grenade") {
    const type = pickup.grenadeType || "frag";
    fighter.grenadeInventory[type] = Math.min(
      6,
      fighter.grenadeInventory[type] + 1,
    );
    fighter.grenadeType = type;
    showToast(
      fighter.playerName +
        " PICKED UP " +
        (type === "mine" ? "PROXY MINE" : GRENADE_LABELS[type] + " GRENADE"),
    );
  }
  updateHUD();
}

/* =========================================================================
   WAVES
   ========================================================================= */
// Starts the next enemy wave, scales difficulty, and refreshes the battlefield for the upcoming fight.
function nextWave() {
  if (state.wave >= MAX_WAVES) return;
  state.wave++;
  state.remaining = 3 + Math.ceil(state.wave / 5);
  state.maxAlive = Math.min(2 + Math.floor(state.wave / 10), 12);
  state.spawnCd = 40;
  state.waveBreak = 0;
  state.bossSpawned = false;
  if (state.wave > 1) {
    player.grenadeInventory.frag = Math.min(
      6,
      player.grenadeInventory.frag + 1,
    );
  }
  showToast("WAVE " + state.wave + " — CLEAR THE MOBS!");
  sfx("wave");
  updateHUD();
}

// Chooses a safe spawn point for enemies away from the player so combat stays fair and dynamic.
function randomSpawnPoint(avoidX = player ? player.x : 1200) {
  const spots = [];
  for (const p of PLATFORMS) {
    if (p.kind === "ledge" && p.w > 240) {
      for (let x = p.x + 40; x < p.x + p.w - 40; x += 70)
        spots.push({ x, y: p.y });
    }
  }
  for (let x = 80; x < WORLD.w - 80; x += 90) spots.push({ x, y: GROUND_Y });
  const far = spots.filter((s) => Math.abs(s.x - avoidX) > 420);
  const list = far.length > 4 ? far : spots;
  const s = list[(Math.random() * list.length) | 0];
  return { x: s.x, y: s.y - 46 };
}

// Picks a valid enemy spawn location that keeps mobs off-screen or in a controlled area.
function randomEnemySpawnPoint() {
  const width = 26;
  const minX = 40;
  const maxX = WORLD.w - width - 40;
  const playerX = player ? player.x + player.w / 2 : WORLD.w / 2;
  const minDistance = 220;
  const maxDistance = Math.min(700, viewW() * 0.7);
  const sides = [
    {
      direction: -1,
      min: Math.max(minX, playerX - maxDistance),
      max: Math.min(maxX, playerX - minDistance - width / 2),
    },
    {
      direction: 1,
      min: Math.max(minX, playerX + minDistance - width / 2),
      max: Math.min(maxX, playerX + maxDistance),
    },
  ].filter((side) => side.min <= side.max);
  const side = sides[(Math.random() * sides.length) | 0];
  const x = side ? rand(side.min, side.max) : rand(minX, maxX);

  if (Math.random() < 0.25) {
    return { x, y: -rand(140, 380) };
  }

  const surfaces = PLATFORMS.filter(
    (platform) => x + width > platform.x && x < platform.x + platform.w,
  );
  const surface = surfaces[(Math.random() * surfaces.length) | 0];
  return { x, y: surface.y - 44 };
}

// Selects a respawn spot for a duel match so both fighters appear in balanced positions.
function randomDuelRespawnPoint(opponent) {
  const opponentX = opponent.x + opponent.w / 2;
  const opponentFeet = opponent.y + opponent.h;
  const spots = [];

  for (const platform of PLATFORMS) {
    if (Math.abs(platform.y - opponentFeet) > 220) continue;
    const minCenterX = Math.max(platform.x + 30, opponentX - 320);
    const maxCenterX = Math.min(
      platform.x + platform.w - 30,
      opponentX + 320,
      WORLD.w - 30,
    );
    for (let centerX = minCenterX; centerX <= maxCenterX; centerX += 40) {
      const distance = Math.abs(centerX - opponentX);
      if (distance >= 120 && distance <= 320) {
        spots.push({ x: centerX - 13, y: platform.y - 46 });
      }
    }
  }

  if (spots.length > 0) return spots[(Math.random() * spots.length) | 0];

  const direction = Math.random() < 0.5 ? -1 : 1;
  return {
    x: clamp(opponentX + direction * 220 - 13, 0, WORLD.w - 26),
    y: clamp(opponent.y, 0, GROUND_Y - 44),
  };
}

// Creates a surprise loot drop at a random point on the map to keep rewards unpredictable.
function spawnRandomPickupDrop() {
  if (pickups.length >= 6) return;
  const spawn = randomSpawnPoint();
  const surfaceY = spawn.y + 46;
  if (Math.random() < 0.68) {
    const weapons = ["smg", "shotgun", "rifle"];
    dropPickup(
      spawn.x + 13,
      surfaceY - 18,
      "weapon",
      weapons[(Math.random() * weapons.length) | 0],
    );
    showToast("WEAPON DROP!");
  } else {
    const type = GRENADE_TYPES[(Math.random() * GRENADE_TYPES.length) | 0];
    dropPickup(spawn.x + 13, surfaceY - 18, "grenade", type);
    showToast(
      (type === "mine" ? "PROXY MINE" : GRENADE_LABELS[type] + " GRENADE") +
        " DROP!",
    );
  }
}

// Maintains enemy waves and pickup spawning so the game continuously escalates over time.
function handleSpawning() {
  if (state.waveBreak > 0) {
    state.waveBreak--;
    if (state.waveBreak === 0) {
      if (state.wave < MAX_WAVES) {
        nextWave();
      } else {
        state.waveBreak = -1;
        showToast("ALL " + MAX_WAVES + " WAVES CLEARED!");
      }
    }
    return;
  }
  if (state.waveBreak < 0) return;
  if (
    state.remaining > 0 &&
    enemies.filter((e) => e.alive).length < state.maxAlive
  ) {
    state.spawnCd--;
    if (state.spawnCd <= 0) {
      const p = randomEnemySpawnPoint();
      const e = makeEnemy(p.x, p.y);
      enemies.push(e);
      state.remaining--;
      state.spawnCd = Math.round(rand(50, 100));
      // spawn puff
      for (let i = 0; i < 12; i++)
        particles.push({
          x: p.x,
          y: p.y + 20,
          vx: rand(-2, 2),
          vy: rand(-3, -0.5),
          life: rand(20, 40),
          max: 40,
          size: rand(2, 4),
          color: "#4a5470",
          grav: 0.06,
        });
      updateHUD();
    }
  }
  if (state.remaining === 0 && state.waveBreak === 0) {
    const aliveEnemies = enemies.filter((e) => e.alive).length;
    if (!state.bossSpawned) {
      if (aliveEnemies === 0) {
        state.bossSpawned = true;
        if (state.wave % BOSS_WAVE_INTERVAL === 0) {
          enemies.push(makeBoss());
          showToast("BOSS INCOMING!");
        } else {
          showToast("WAVE " + state.wave + " CLEARED");
          state.waveBreak = 150;
        }
        updateHUD();
      }
      return;
    }
    const bossAlive = enemies.some((e) => e.isBoss && e.alive);
    if (aliveEnemies === 0 && !bossAlive) {
      if (state.wave >= MAX_WAVES) {
        state.waveBreak = -1;
        showToast("ALL " + MAX_WAVES + " WAVES CLEARED!");
      } else {
        showToast("WAVE " + state.wave + " CLEARED");
        state.waveBreak = 150;
      }
      updateHUD();
    }
  }
}

/* =========================================================================
   UPDATE
   ========================================================================= */
// Player 1 and Player 2 movement, jumping, aiming, and firing all pass through this function.
// It mixes keyboard input, mouse aim, and touch-stick input to keep the combat controls consistent across solo and duel play.
function updatePlayer(p = player, isSecondPlayer = false) {
  if (!p.alive) return;

  // ---- input vector
  let mx = 0,
    jumpHeld = false;
  if (isSecondPlayer) {
    if (keys.ArrowLeft) mx -= 1;
    if (keys.ArrowRight) mx += 1;
    jumpHeld = !!keys.ArrowUp;
  } else {
    if (keys.KeyA || (state.gameMode !== "duel" && keys.ArrowLeft)) mx -= 1;
    if (keys.KeyD || (state.gameMode !== "duel" && keys.ArrowRight)) mx += 1;
    jumpHeld = !!(keys.KeyW || (state.gameMode !== "duel" && keys.ArrowUp));
  }
  if (!isSecondPlayer && touch.move.active) {
    const dx = touch.move.dx;
    if (Math.abs(dx) > 0.18) mx += dx;
    if (touch.move.dy < -0.25) jumpHeld = true;
  }
  const downHeld = isSecondPlayer
    ? !!keys.ArrowDown
    : !!(keys.KeyS || (state.gameMode !== "duel" && keys.ArrowDown)) ||
      (touch.move.active && touch.move.dy > 0.25);

  // ---- ladder logic
  const L = ladderAt(p);
  if (L && (jumpHeld || downHeld) && !p.climbing) {
    p.climbing = true;
    p.ladder = L;
    p.vy = 0;
    p.vx = 0;
  }
  if (p.climbing) {
    const l = p.ladder;
    if (!l || p.y + p.h < l.top - 4 || p.y + p.h > l.bot + 40) {
      p.climbing = false;
    } else {
      const cy = p.y + p.h;
      const inX = p.x + p.w / 2 > l.x - 30 && p.x + p.w / 2 < l.x + 30;
      if (!inX) p.climbing = false;
      else {
        p.vy = 0;
        if (jumpHeld) p.vy = -2.6;
        else if (downHeld) p.vy = 2.6;
        p.x += (l.x - (p.x + p.w / 2)) * 0.18;
        p.vx = mx * 1.1;
        p.x += p.vx;
        p.y += p.vy;
        // reached top of ladder -> step onto the platform
        if (p.y + p.h <= l.top + 2) {
          p.y = l.top - p.h;
          p.climbing = false;
          p.onGround = true;
        }
        // reached bottom
        if (p.y + p.h >= l.bot) {
          p.y = l.bot - p.h;
          p.climbing = false;
          p.onGround = true;
        }
        // jump out of ladder
        if (keys.Space && !p.firedPress) {
          /* firing still allowed */
        }
        p.walkT += 0.2;
        return;
      }
    }
  }

  // ---- horizontal movement
  const accel = p.onGround ? 0.85 : 0.45;
  const target = mx * MOVE_SPEED;
  if (Math.abs(target) > 0.01) {
    p.vx += (target - p.vx) * accel * 0.5;
    if (
      (isSecondPlayer ||
        (!touch.aim.active && (!mouse.active || touch.move.active))) &&
      target !== 0
    )
      p.facing = target > 0 ? 1 : -1;
  } else {
    p.vx *= p.onGround ? 0.8 : 0.94;
    if (Math.abs(p.vx) < 0.05) p.vx = 0;
  }
  p.vx = clamp(p.vx, -6.5, 6.5);

  // ---- jump
  if (jumpHeld && p.onGround) {
    p.vy = JUMP_VEL;
    p.onGround = false;
    for (let i = 0; i < 5; i++)
      particles.push({
        x: p.x + p.w / 2,
        y: p.y + p.h,
        vx: rand(-1.4, 1.4),
        vy: rand(-0.4, 0.6),
        life: 16,
        max: 16,
        size: 2,
        color: "#5a6478",
        grav: 0.05,
      });
  }

  // ---- gravity & collision
  p.vy += GRAVITY;
  p.vy = Math.min(p.vy, 18);
  p.x += p.vx;
  collideX(p);
  p.y += p.vy;
  collideY(p);

  // ---- aiming
  let aimX = 0;
  let aimY = 0;
  if (isSecondPlayer) {
    if (keys.Numpad4) aimX -= 1;
    if (keys.Numpad6) aimX += 1;
    if (keys.Numpad8) aimY -= 1;
    if (keys.Numpad2) aimY += 1;
  } else {
    if (keys.KeyA || (state.gameMode !== "duel" && keys.ArrowLeft)) aimX -= 1;
    if (keys.KeyD || (state.gameMode !== "duel" && keys.ArrowRight)) aimX += 1;
    if (keys.KeyW || (state.gameMode !== "duel" && keys.ArrowUp)) aimY -= 1;
    if (keys.KeyS || (state.gameMode !== "duel" && keys.ArrowDown)) aimY += 1;
  }

  if (aimX !== 0 || aimY !== 0) {
    p.aim = Math.atan2(aimY, aimX);
    p.facing = aimX >= 0 ? 1 : -1;
  } else if (!isSecondPlayer && touch.aim.active && touch.aim.mag > 0.12) {
    p.aim = Math.atan2(touch.aim.dy, touch.aim.dx);
    p.facing = touch.aim.dx >= 0 ? 1 : -1;
    if (touch.aim.mag >= 0.96) {
      touch.aim.fired = true;
    }
  } else if (aimX !== 0 || aimY !== 0) {
    p.aim = Math.atan2(aimY, aimX);
    p.facing = aimX >= 0 ? 1 : -1;
  } else if (!isSecondPlayer) {
    p.aim = p.facing > 0 ? 0 : Math.PI;
  }

  // ---- firing
  const w = WEAPONS[p.weapon];
  const touchAimFiring =
    !isSecondPlayer && touch.aim.active && touch.aim.mag >= 0.96;
  const shooting = isSecondPlayer
    ? !!keys.Numpad5
    : keys.Space || mouse.down || touchAimFiring;
  if (shooting && (w.auto || touchAimFiring || !p.firedPress)) {
    fireWeapon(p);
  }
  p.firedPress = shooting;

  // ---- timers
  if (p.fireCd > 0) p.fireCd--;
  if (p.muzzle > 0) p.muzzle--;
  if (p.hitT > 0) p.hitT--;
  if (p.meleeCd > 0) p.meleeCd--;
  if (p.reloading) {
    p.reloadT--;
    if (p.reloadT <= 0) {
      p.reloading = false;
      p.mag = WEAPONS[p.weapon].mag;
      updateHUD();
    }
  }
  if (Math.abs(p.vx) > 0.5 && p.onGround) p.walkT += Math.abs(p.vx) * 0.09;
  if (p.vy > 20) damage(p, 999, p.x);
}

// Enemy and boss AI use this update loop to chase the player, climb ladders, jump over gaps, and fire back when a target is in range.
// Boss enemies are tuned to move faster, deal more damage, and take longer to finish off.
function updateEnemy(e) {
  if (!e.alive) return;
  const pcx = player.x + player.w / 2,
    pcy = player.y + player.h / 2;
  const cx = e.x + e.w / 2,
    cy = e.y + e.h / 2;
  const dx = pcx - cx,
    dy = pcy - cy;
  const dist = Math.abs(dx);
  e.facing = dx > 0 ? 1 : -1;

  // aim at player with slight lag
  const targetAim = Math.atan2(player.y + 18 - (e.y + 18), pcx - cx);
  e.aim = targetAim;

  // ladder usage when the player is far above / below
  const L = ladderAt(e);
  if (
    L &&
    Math.abs(dy) > 90 &&
    Math.abs(e.x + e.w / 2 - L.x) < 60 &&
    Math.random() < 0.06
  ) {
    e.climbing = true;
    e.ladder = L;
  }
  if (e.climbing) {
    const l = e.ladder;
    if (!l || player.hp <= 0) {
      e.climbing = false;
    } else {
      const wantUp = player.y + player.h < e.y + e.h;
      e.vy = wantUp ? -2.4 : 2.4;
      e.vx = 0;
      e.x += (l.x - (e.x + e.w / 2)) * 0.16;
      e.y += e.vy;
      if (e.y + e.h <= l.top + 2) {
        e.y = l.top - e.h;
        e.climbing = false;
        e.onGround = true;
      }
      if (e.y + e.h >= l.bot) {
        e.y = l.bot - e.h;
        e.climbing = false;
        e.onGround = true;
      }
      e.walkT += 0.2;
      if (e.fireCd > 0) e.fireCd--;
      if (Math.abs(dy) < 70 && Math.random() < 0.02) fireWeapon(e);
      return;
    }
  }

  // horizontal chase
  const speed = (0.42 + state.wave * 0.018) * (e.isBoss ? 1.25 : 1);
  if (dist > 210) e.vx += e.facing * speed;
  else if (dist < 120) e.vx -= e.facing * speed * 0.7;
  else e.vx *= 0.9;
  e.vx *= 0.86;
  const maxSpeed = Math.min(
    e.isBoss ? 8 : 7,
    (e.isBoss ? 4.2 : 3.4) + state.wave * 0.035,
  );
  e.vx = clamp(e.vx, -maxSpeed, maxSpeed);

  // hop over obstacles / toward the player
  if (e.onGround) {
    if (Math.random() < 0.012) e.vy = JUMP_VEL * 0.92;
    if (
      Math.abs(dy) > 60 &&
      Math.abs(dy) < 190 &&
      dist < 260 &&
      Math.random() < 0.05
    )
      e.vy = JUMP_VEL * 0.95;
  }

  e.vy += GRAVITY;
  e.vy = Math.min(e.vy, 18);
  e.x += e.vx;
  collideX(e);
  e.y += e.vy;
  collideY(e);

  if (e.fireCd > 0) e.fireCd--;
  if (e.muzzle > 0) e.muzzle--;
  if (e.hitT > 0) e.hitT--;
  if (Math.abs(e.vx) > 0.4 && e.onGround) e.walkT += Math.abs(e.vx) * 0.09;

  // shoot when roughly on the same level
  const sameLevel = Math.abs(dy) < 70;
  if (sameLevel && dist < 560 && !e.reloading) {
    if (e.mag <= 0) {
      startReload(e);
    } else if (
      e.fireCd <= 0 &&
      Math.random() <
        Math.min(0.3, 0.035 + state.wave * 0.0025) * (e.isBoss ? 1.7 : 1)
    ) {
      fireWeapon(e);
    }
  } else if (e.mag <= 0 && e.fireCd <= 0) {
    startReload(e);
  }
  if (e.reloading) {
    e.reloadT--;
    if (e.reloadT <= 0) {
      e.reloading = false;
      e.mag = WEAPONS[e.weapon].mag;
    }
  }
}

// Advances all bullets, checks collisions, and removes spent projectiles from the scene.
function updateBullets() {
  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i];
    const steps = 2;
    let dead = false;
    for (let s = 0; s < steps && !dead; s++) {
      b.x += b.vx / steps;
      b.y += b.vy / steps;
      // platforms
      for (const p of PLATFORMS) {
        if (b.x > p.x && b.x < p.x + p.w && b.y > p.y && b.y < p.y + p.h) {
          dead = true;
          for (let k = 0; k < 4; k++)
            particles.push({
              x: b.x,
              y: b.y,
              vx: rand(-2.2, 2.2),
              vy: rand(-2.4, 0.6),
              life: rand(10, 22),
              max: 22,
              size: rand(1, 3),
              color: "#ffd166",
              grav: 0.2,
            });
          break;
        }
      }
      if (dead) break;
      // fighters
      const list =
        b.owner === "player"
          ? state.gameMode === "duel"
            ? [secondPlayer]
            : enemies
          : b.owner === "player2"
            ? [player]
            : [player];
      for (const f of list) {
        if (!f || !f.alive) continue;
        if (b.x > f.x && b.x < f.x + f.w && b.y > f.y && b.y < f.y + f.h) {
          damage(f, b.dmg, b.x, b.attacker);
          dead = true;
          break;
        }
      }
    }
    b.life--;
    if (
      dead ||
      b.life <= 0 ||
      b.x < -50 ||
      b.x > WORLD.w + 50 ||
      b.y < -200 ||
      b.y > WORLD.h + 50
    ) {
      bullets.splice(i, 1);
    }
  }
}

// Moves grenade projectiles, handles timers, and triggers explosion logic when they detonate.
function updateGrenades() {
  for (let i = grenades.length - 1; i >= 0; i--) {
    const g = grenades[i];
    g.vy += 0.55;
    g.x += g.vx;
    g.y += g.vy;
    g.rot += g.vx * 0.12;
    // bounce on platforms
    for (const p of PLATFORMS) {
      if (g.x > p.x && g.x < p.x + p.w && g.y > p.y && g.y < p.y + p.h) {
        // determine side
        const prevY = g.y - g.vy;
        if (prevY <= p.y) {
          g.y = p.y - 1;
          g.vy *= -0.42;
          g.vx *= 0.72;
        } else {
          g.x -= g.vx;
          g.vx *= -0.5;
        }
      }
    }
    if (g.x < 4) {
      g.x = 4;
      g.vx *= -0.5;
    }
    if (g.x > WORLD.w - 4) {
      g.x = WORLD.w - 4;
      g.vx *= -0.5;
    }
    g.fuse--;
    if (g.fuse <= 0) {
      if (g.type === "gas") {
        gasClouds.push({
          x: g.x,
          y: g.y,
          radius: 112,
          duration: 360,
          tick: 1,
          owner: g.owner,
          attacker: g.attacker,
        });
      } else {
        explode(g.x, g.y, 100, 78, g.attacker, g.owner);
      }
      grenades.splice(i, 1);
    }
  }
}

// Updates poison or gas effects, their lifetime, and damage ticks over time.
function updateGasClouds() {
  for (let i = gasClouds.length - 1; i >= 0; i--) {
    const cloud = gasClouds[i];
    cloud.duration--;
    cloud.tick--;
    if (cloud.tick <= 0) {
      cloud.tick = 30;
      for (const target of grenadeTargets(cloud.owner)) {
        if (!target?.alive) continue;
        const distance = Math.hypot(
          target.x + target.w / 2 - cloud.x,
          target.y + target.h / 2 - cloud.y,
        );
        if (distance < cloud.radius) {
          damage(target, 7, cloud.x, cloud.attacker);
        }
      }
    }
    if (cloud.duration <= 0) gasClouds.splice(i, 1);
  }
}

// Advances proxy mine timers and detonation logic for trap-like explosive devices.
function updateProxyMines() {
  for (let i = proxyMines.length - 1; i >= 0; i--) {
    const mine = proxyMines[i];
    mine.vy = Math.min(mine.vy + GRAVITY, 12);
    mine.y += mine.vy;
    for (const platform of PLATFORMS) {
      if (
        mine.x >= platform.x &&
        mine.x <= platform.x + platform.w &&
        mine.y >= platform.y &&
        mine.y <= platform.y + platform.h
      ) {
        mine.y = platform.y - 3;
        mine.vy = 0;
        break;
      }
    }
    if (mine.armTimer > 0) {
      mine.armTimer--;
      continue;
    }
    const triggered = grenadeTargets(mine.owner).some((target) => {
      if (!target?.alive) return false;
      return (
        Math.hypot(
          target.x + target.w / 2 - mine.x,
          target.y + target.h / 2 - mine.y,
        ) < 72
      );
    });
    if (triggered) {
      explode(mine.x, mine.y, 116, 90, mine.attacker, mine.owner);
      proxyMines.splice(i, 1);
    }
  }
}

// Updates visual particles so hit flashes, muzzle effects, and explosions animate correctly.
function updateParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.vy += p.grav || 0;
    p.x += p.vx;
    p.y += p.vy;
    p.vx *= 0.99;
    p.life--;
    if (p.life <= 0) particles.splice(i, 1);
  }
  if (particles.length > 320) particles.splice(0, particles.length - 320);
}

// Advances pickup animation and visibility while checking whether they can be collected.
function updatePickups() {
  for (const p of pickups) {
    p.bob += 0.09;
    // gravity so dropped pickups land
    let onGround = false;
    for (const s of PLATFORMS) {
      if (
        p.x < s.x + s.w &&
        p.x + p.w > s.x &&
        p.y + p.h <= s.y + 8 &&
        p.y + p.h + p.vy >= s.y
      ) {
        p.y = s.y - p.h;
        p.vy = 0;
        onGround = true;
      }
    }
    if (!onGround) {
      p.vy = Math.min(p.vy + 0.7, 10);
      p.y += p.vy;
    }
    if (p.y > WORLD.h) {
      p.y = GROUND_Y - 30;
      p.vy = 0;
    }
  }
}

// Updates floating damage and status indicators so combat feedback follows the fighters smoothly.
function updateFloaters() {
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.y -= 0.6;
    f.life--;
    if (f.life <= 0) floaters.splice(i, 1);
  }
}

// Removes dead or offscreen enemies so the active list stays efficient and the game remains stable.
function cleanupEnemies() {
  for (let i = enemies.length - 1; i >= 0; i--) {
    const e = enemies[i];
    if (!e.alive || e.hp <= 0) {
      e.deadT = (e.deadT || 0) + 1;
      if (e.deadT > 90) enemies.splice(i, 1);
    }
  }
}

/* =========================================================================
   MAIN UPDATE
   ========================================================================= */
// Runs the main game loop to update movement, combat, pickups, spawning, and the world state each frame.
function update() {
  state.time++;
  if (state.shake > 0) state.shake *= 0.87;

  if (player && player.alive) updatePlayer();
  if (secondPlayer && secondPlayer.alive) updatePlayer(secondPlayer, true);
  for (const e of enemies) updateEnemy(e);
  updateBullets();
  updateGrenades();
  updateGasClouds();
  updateProxyMines();
  updateParticles();
  updatePickups();
  updateFloaters();
  if (state.gameMode === "duel") updateDuelRound();
  updateRandomPickupDrops();
  if (state.gameMode === "single") handleSpawning();
  cleanupEnemies();

  if (state.gameMode === "duel" && player && secondPlayer) {
    updateDuelCameraZoom();
    camFollow(
      {
        x: (player.x + secondPlayer.x) / 2,
        y: (player.y + secondPlayer.y) / 2,
        w: 26,
        h: 44,
      },
      false,
    );
  } else {
    updateDuelCameraZoom();
    if (player) camFollow(player, false);
  }

  // pickup prompt
  const p1Pickup = nearestPickup(player);
  const p2Pickup =
    state.gameMode === "duel" ? nearestPickup(secondPlayer) : null;
  const promptEl = document.getElementById("prompt");
  if (p1Pickup || p2Pickup) {
    promptEl.classList.add("on");
    promptEl.innerHTML =
      state.gameMode === "duel"
        ? "P1 <b>E</b> · P2 NUMPAD <b>+</b> TO PICK UP"
        : body.classList.contains("touch-on")
          ? "TAP <b>PICK</b> TO GRAB"
          : "PRESS <b>E</b> TO PICK UP";
  } else promptEl.classList.remove("on");

  updateHUD();
}

// Duel-mode respawn logic resets a fallen fighter after a short delay so the 1v1 match can continue with fair spacing and a clean weapon state.
function respawnDuelPlayer(isSecondPlayer) {
  const opponent = isSecondPlayer ? player : secondPlayer;
  const spawn = randomDuelRespawnPoint(opponent);
  if (isSecondPlayer) {
    secondPlayer = makePlayer(
      spawn.x,
      spawn.y,
      selectedP2Character,
      true,
      p2PlayerName,
    );
    secondPlayer.facing = -1;
    secondPlayer.aim = Math.PI;
  } else {
    player = makePlayer(spawn.x, spawn.y);
    player.facing = 1;
  }
  updateHUD();
}

// 1v1 match flow: this function counts down the duel timer, watches player kills, and triggers the duel end screen when time expires or a fighter is crowned winner.
function updateDuelRound() {
  if (state.p1RespawnFrames > 0) {
    state.p1RespawnFrames--;
    if (state.p1RespawnFrames === 0) respawnDuelPlayer(false);
  }
  if (state.p2RespawnFrames > 0) {
    state.p2RespawnFrames--;
    if (state.p2RespawnFrames === 0) respawnDuelPlayer(true);
  }
  state.duelTimeFrames--;
  if (state.duelTimeFrames <= 0 && !state.duelEndScheduled) {
    state.duelTimeFrames = 0;
    state.duelEndScheduled = true;
    state.scene = "dead";
    const winner =
      state.p1Kills === state.p2Kills
        ? "DRAW"
        : state.p1Kills > state.p2Kills
          ? state.playerName.toUpperCase()
          : p2PlayerName.toUpperCase();
    showDuelGameOver(winner);
  }
}

/* =========================================================================
   RENDER
   ========================================================================= */
const stars = Array.from({ length: 150 }, () => ({
  x: Math.random() * WORLD.w,
  y: Math.random() * 460,
  r: Math.random() * 1.6 + 0.3,
  a: Math.random() * 0.7 + 0.25,
  tw: Math.random() * 6.28,
}));

// Draws the far skyline layer used to create depth and a sense of distance in the city scene.
const cityFar = (() => {
  const arr = [];
  let x = -200;
  while (x < WORLD.w + 300) {
    const w = 40 + Math.random() * 110;
    const h = 70 + Math.random() * 190;
    arr.push({ x, w, h, win: Math.random() < 0.7 });
    x += w + 6 + Math.random() * 26;
  }
  return arr;
})();

let brickPattern = null;
// Creates a brick object so walls and decorative structures can be rendered consistently.
function makeBrick() {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 32;
  const g = c.getContext("2d");
  g.fillStyle = "#232a3c";
  g.fillRect(0, 0, 64, 32);
  g.strokeStyle = "#1a2030";
  g.lineWidth = 2;
  g.beginPath();
  g.moveTo(0, 16);
  g.lineTo(64, 16);
  g.moveTo(0, 32);
  g.lineTo(64, 32);
  g.moveTo(16, 0);
  g.lineTo(16, 16);
  g.moveTo(48, 16);
  g.lineTo(48, 32);
  g.stroke();
  g.fillStyle = "rgba(255,255,255,.022)";
  for (let i = 0; i < 26; i++)
    g.fillRect(Math.random() * 64, Math.random() * 32, 2, 1);
  return ctx.createPattern(c, "repeat");
}

// Paints the background sky and atmosphere for the current map before drawing the gameplay layer.
function drawSky() {
  if (selectedMapId !== "map3") return;
  const grd = ctx.createLinearGradient(0, 0, 0, VH);
  grd.addColorStop(0, "#060a1a");
  grd.addColorStop(0.45, "#0d1631");
  grd.addColorStop(1, "#1a2244");
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, VW, VH);

  // parallax factor
  const px = 0.22,
    py = 0.12;

  // stars
  ctx.save();
  ctx.globalAlpha = 0.9;
  for (const s of stars) {
    const sx = (s.x - cam.x * px) * scale;
    const sy = (s.y - cam.y * py) * scale;
    if (sx < -20 || sx > VW + 20 || sy < -20 || sy > VH + 20) continue;
    const tw = 0.6 + 0.4 * Math.sin(state.time * 0.03 + s.tw);
    ctx.fillStyle = "rgba(200,220,255," + s.a * tw + ")";
    ctx.fillRect(sx, sy, s.r * scale, s.r * scale);
  }
  ctx.restore();

  // moon
  const mx = (1620 - cam.x * px) * scale;
  const my = (190 - cam.y * py) * scale;
  const mr = 82 * scale;
  const glow = ctx.createRadialGradient(mx, my, mr * 0.4, mx, my, mr * 3.6);
  glow.addColorStop(0, "rgba(255,238,196,.28)");
  glow.addColorStop(0.4, "rgba(255,230,180,.09)");
  glow.addColorStop(1, "rgba(255,230,180,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(mx, my, mr * 3.6, 0, 6.29);
  ctx.fill();
  ctx.fillStyle = "#f4e7c6";
  ctx.beginPath();
  ctx.arc(mx, my, mr, 0, 6.29);
  ctx.fill();
  ctx.fillStyle = "rgba(210,196,164,.5)";
  ctx.beginPath();
  ctx.arc(mx - mr * 0.28, my - mr * 0.18, mr * 0.16, 0, 6.29);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(mx + mr * 0.3, my + mr * 0.24, mr * 0.11, 0, 6.29);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(mx + mr * 0.06, my - mr * 0.42, mr * 0.08, 0, 6.29);
  ctx.fill();

  // far city silhouette
  ctx.fillStyle = "#0f1730";
  const baseY = (500 - cam.y * py) * scale;
  for (const b of cityFar) {
    const bx = (b.x - cam.x * px) * scale;
    const bh = b.h * scale;
    if (bx < -200 || bx > VW + 200) continue;
    ctx.fillRect(bx, baseY - bh, b.w * scale, bh);
    if (b.win) {
      ctx.fillStyle = "rgba(255,214,140,.16)";
      for (let wy = 0; wy < b.h - 20; wy += 26) {
        for (let wx = 6; wx < b.w - 10; wx += 18) {
          if (Math.random() < 0.32)
            ctx.fillRect(
              bx + wx * scale,
              baseY - bh + wy * scale,
              4 * scale,
              5 * scale,
            );
        }
      }
      ctx.fillStyle = "#0f1730";
    }
  }
  // utility poles + wires
  ctx.strokeStyle = "rgba(10,14,26,.9)";
  ctx.lineWidth = 3 * scale;
  const poles = [140, 620, 1180, 1720, 2280].flatMap((x) =>
    [0, 2400, 4800].map((offset) => x + offset),
  );
  for (const p of poles) {
    const sx = (p - cam.x * 0.35) * scale;
    const syTop = (150 - cam.y * 0.2) * scale;
    const syBot = (520 - cam.y * 0.2) * scale;
    ctx.beginPath();
    ctx.moveTo(sx, syBot);
    ctx.lineTo(sx, syTop);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(sx - 26 * scale, syTop + 26 * scale);
    ctx.lineTo(sx + 26 * scale, syTop + 26 * scale);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(8,11,22,.75)";
  ctx.lineWidth = 1.6 * scale;
  for (let i = 0; i < poles.length - 1; i++) {
    const ax = (poles[i] - cam.x * 0.35) * scale;
    const bx = (poles[i + 1] - cam.x * 0.35) * scale;
    const y = (168 - cam.y * 0.2) * scale;
    ctx.beginPath();
    ctx.moveTo(ax, y);
    ctx.quadraticCurveTo((ax + bx) / 2, y + 26 * scale, bx, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(ax, y + 18 * scale);
    ctx.quadraticCurveTo((ax + bx) / 2, y + 50 * scale, bx, y + 18 * scale);
    ctx.stroke();
  }
}

// Draws the wall segments and platform boundaries used by the game world.
function drawWall() {
  if (selectedMapId !== "map3") {
    const background = mapBackgrounds[selectedMapId];
    ctx.fillStyle = selectedMapId === "map2" ? "#42a7e8" : "#11182b";
    ctx.fillRect(0, 0, WORLD.w, WORLD.h);
    if (background && background.complete && background.naturalWidth > 0) {
      for (const offset of [0, 2400, 4800]) {
        ctx.drawImage(background, offset, 0, 2400, WORLD.h);
      }
    }
    return;
  }
  if (!brickPattern) brickPattern = makeBrick();
  ctx.save();
  ctx.fillStyle = brickPattern;
  ctx.fillRect(0, 300, WORLD.w, WORLD.h - 300);
  const g = ctx.createLinearGradient(0, 300, 0, WORLD.h);
  g.addColorStop(0, "rgba(6,9,20,.55)");
  g.addColorStop(0.5, "rgba(6,9,20,.32)");
  g.addColorStop(1, "rgba(6,9,20,.72)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 300, WORLD.w, WORLD.h - 300);
  ctx.restore();

  // structural columns
  ctx.fillStyle = "#1b2132";
  for (const offset of [0, 2400, 4800]) {
    for (const x of [60, 420, 900, 1180, 1620, 1900, 2340]) {
      ctx.fillRect(x + offset, 300, 18, WORLD.h - 300);
    }
  }

  // lamp glows on the wall
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  for (const L of LAMPS) {
    const g2 = ctx.createRadialGradient(L.x, L.y + 16, 4, L.x, L.y + 16, 118);
    g2.addColorStop(0, "rgba(255,196,110,.30)");
    g2.addColorStop(0.45, "rgba(255,170,80,.10)");
    g2.addColorStop(1, "rgba(255,170,80,0)");
    ctx.fillStyle = g2;
    ctx.beginPath();
    ctx.arc(L.x, L.y + 16, 118, 0, 6.29);
    ctx.fill();
  }
  ctx.restore();
  for (const L of LAMPS) drawLamp(L.x, L.y);
}

// Draws a lamp prop at the specified position to add environment detail and lighting depth.
function drawLamp(x, y) {
  ctx.fillStyle = "#1a2030";
  ctx.fillRect(x - 1, y - 14, 3, 14);
  ctx.fillStyle = "#2b3348";
  ctx.beginPath();
  ctx.moveTo(x - 8, y);
  ctx.lineTo(x + 8, y);
  ctx.lineTo(x + 5, y + 9);
  ctx.lineTo(x - 5, y + 9);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#ffd88a";
  ctx.fillRect(x - 4, y + 3, 8, 5);
  ctx.fillStyle = "rgba(255,225,160,.9)";
  ctx.fillRect(x - 2, y + 5, 4, 3);
}

// Renders directional or decorative signs to reinforce the scene and map identity.
function drawSigns() {
  for (const s of SIGNS) {
    ctx.save();
    ctx.translate(s.x, s.y);
    // board
    ctx.fillStyle = "rgba(0,0,0,.45)";
    ctx.fillRect(4, 5, s.w, s.h);
    ctx.fillStyle = s.bg;
    ctx.fillRect(0, 0, s.w, s.h);
    ctx.strokeStyle = "rgba(0,0,0,.45)";
    ctx.lineWidth = 3;
    ctx.strokeRect(1.5, 1.5, s.w - 3, s.h - 3);
    if (s.flag) {
      // sun rays
      ctx.save();
      ctx.translate(s.w - 26, 22);
      ctx.fillStyle = "#f5c518";
      ctx.beginPath();
      ctx.arc(0, 0, 8, 0, 6.29);
      ctx.fill();
      ctx.strokeStyle = "#f5c518";
      ctx.lineWidth = 2;
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 10, Math.sin(a) * 10);
        ctx.lineTo(Math.cos(a) * 15, Math.sin(a) * 15);
        ctx.stroke();
      }
      ctx.restore();
    }
    // text
    ctx.fillStyle = s.fg;
    ctx.font = s.size + 'px "Press Start 2P", monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const lh = s.size + 8;
    const startY = s.h / 2 - ((s.lines.length - 1) * lh) / 2;
    s.lines.forEach((ln, i) => {
      ctx.fillText(ln, s.w / 2, startY + i * lh);
    });
    ctx.restore();
  }
}

// Draws a platform or ground tile using the platform data and current visual theme.
function drawPlatform(p) {
  const { x, y, w, h } = p;
  // drop shadow
  ctx.fillStyle = "rgba(0,0,0,.35)";
  ctx.fillRect(x + 3, y + 6, w, h);
  if (selectedMapId !== "map3") {
    ctx.fillStyle =
      selectedMapId === "map2"
        ? p.kind === "ground"
          ? "#6f5338"
          : "#94683b"
        : p.kind === "ground"
          ? "#242b3a"
          : "#414b5c";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle =
      selectedMapId === "map2"
        ? "rgba(255,220,145,.45)"
        : "rgba(220,232,245,.55)";
    ctx.fillRect(x, y, w, 4);
    ctx.fillStyle = "rgba(0,0,0,.22)";
    ctx.fillRect(x, y + h - 4, w, 4);
    return;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = "#31552b";
  ctx.fillRect(x, y, w, h);
  if (bambooImage.complete && bambooImage.naturalWidth) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(bambooImage, x, y, w, h);
  }
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, "rgba(255,255,255,.04)");
  g.addColorStop(0.45, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,.35)");
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  // top edge highlight
  ctx.fillStyle = "rgba(255,255,255,.09)";
  ctx.fillRect(x, y, w, 2);
  ctx.restore();
}

// Renders the ladder sprites that allow fighters to climb between floors and platforms.
function drawLadders() {
  for (const L of LADDERS) {
    const h = L.bot - L.top;
    ctx.fillStyle = "#6b5334";
    ctx.fillRect(L.x - 11, L.top, 4, h);
    ctx.fillRect(L.x + 7, L.top, 4, h);
    ctx.fillStyle = "#8a6b42";
    for (let y = L.top + 8; y < L.bot - 4; y += 16) {
      ctx.fillRect(L.x - 11, y, 22, 4);
    }
    ctx.fillStyle = "rgba(0,0,0,.30)";
    for (let y = L.top + 8; y < L.bot - 4; y += 16) {
      ctx.fillRect(L.x - 11, y + 3, 22, 1);
    }
  }
}

// Paints the jeepney prop used as scenery in the occupied city map.
function drawJeepney(x, y) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = "rgba(0,0,0,.4)";
  ctx.fillRect(6, -10, 232, 12);
  // body
  ctx.fillStyle = "#c8332f";
  ctx.fillRect(0, -64, 236, 42);
  ctx.fillStyle = "#e8b93c";
  ctx.fillRect(0, -26, 236, 12);
  ctx.fillStyle = "#2f6fd0";
  ctx.fillRect(0, -14, 236, 14);
  // windows
  ctx.fillStyle = "#101a2c";
  for (let i = 0; i < 4; i++) ctx.fillRect(14 + i * 52, -58, 40, 28);
  ctx.fillStyle = "#7fd4ff";
  ctx.fillRect(228, -60, 8, 32);
  // grill
  ctx.fillStyle = "#d9d9d9";
  ctx.fillRect(226, -22, 10, 20);
  // wheels
  ctx.fillStyle = "#15181f";
  ctx.beginPath();
  ctx.arc(44, 0, 16, 0, 6.29);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(190, 0, 16, 0, 6.29);
  ctx.fill();
  ctx.fillStyle = "#3c4454";
  ctx.beginPath();
  ctx.arc(44, 0, 7, 0, 6.29);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(190, 0, 7, 0, 6.29);
  ctx.fill();
  // sign
  ctx.fillStyle = "#f0e6c8";
  ctx.fillRect(24, -84, 96, 18);
  ctx.fillStyle = "#2a2118";
  ctx.font = '8px "Press Start 2P", monospace';
  ctx.textAlign = "center";
  ctx.fillText("BAYANIHAN", 72, -71);
  ctx.restore();
}

// Draws decorative map objects such as crates, signs, and environmental props.
function drawProp(p) {
  const { x, y } = p;
  if (p.t === "crate") {
    ctx.fillStyle = "rgba(0,0,0,.35)";
    ctx.fillRect(x + 3, y - 27, 30, 30);
    ctx.fillStyle = "#8a6134";
    ctx.fillRect(x, y - 30, 30, 30);
    ctx.fillStyle = "#a5763f";
    ctx.fillRect(x, y - 30, 30, 5);
    ctx.strokeStyle = "#5e4021";
    ctx.lineWidth = 3;
    ctx.strokeRect(x + 1.5, y - 28.5, 27, 27);
    ctx.beginPath();
    ctx.moveTo(x + 2, y - 28);
    ctx.lineTo(x + 28, y - 2);
    ctx.moveTo(x + 28, y - 28);
    ctx.lineTo(x + 2, y - 2);
    ctx.stroke();
  } else if (p.t === "barrel") {
    ctx.fillStyle = "rgba(0,0,0,.35)";
    ctx.fillRect(x + 3, y - 36, 26, 38);
    ctx.fillStyle = p.c || "#b5322f";
    ctx.fillRect(x, y - 38, 26, 38);
    ctx.fillStyle = "rgba(255,255,255,.14)";
    ctx.fillRect(x + 3, y - 38, 6, 38);
    ctx.fillStyle = "rgba(0,0,0,.35)";
    ctx.fillRect(x, y - 30, 26, 4);
    ctx.fillRect(x, y - 14, 26, 4);
    ctx.fillStyle = "rgba(0,0,0,.5)";
    ctx.fillRect(x, y - 38, 26, 3);
  } else if (p.t === "plant") {
    ctx.fillStyle = "#3f5a36";
    ctx.fillRect(x - 2, y - 16, 20, 16);
    ctx.fillStyle = "#4f7042";
    ctx.fillRect(x - 4, y - 18, 24, 5);
    ctx.fillStyle = "#3f7a3a";
    ctx.beginPath();
    ctx.ellipse(x + 8, y - 30, 12, 12, 0, 0, 6.29);
    ctx.fill();
    ctx.fillStyle = "#54a24a";
    ctx.beginPath();
    ctx.ellipse(x + 3, y - 26, 7, 8, -0.5, 0, 6.29);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(x + 14, y - 33, 7, 8, 0.4, 0, 6.29);
    ctx.fill();
  } else if (p.t === "chair") {
    ctx.fillStyle = "#7a5a30";
    ctx.fillRect(x, y - 24, 24, 4);
    ctx.fillRect(x + 1, y - 24, 4, 24);
    ctx.fillRect(x + 19, y - 24, 4, 24);
    ctx.fillRect(x, y - 44, 4, 22);
  }
}

// Draws the fighter sprite, weapon, and current facing direction on the canvas.
function drawFighter(f) {
  const cx = f.x + f.w / 2;
  const bot = f.y + f.h;
  const c = f.colors;
  const dead = !f.alive;

  ctx.save();
  if (dead) {
    ctx.globalAlpha = 0.35;
    ctx.translate(cx, bot);
    ctx.rotate((Math.PI / 2) * Math.min(1, (f.deadT || 0) / 24));
    ctx.translate(-cx, -bot);
  }

  // shadow
  ctx.fillStyle = "rgba(0,0,0,.35)";
  ctx.beginPath();
  ctx.ellipse(cx, bot + 2, 14, 4, 0, 0, 6.29);
  ctx.fill();

  if (f === player && touch.aim.active && touch.aim.mag > 0.12) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,80,90,.82)";
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(cx, f.y + 20);
    ctx.lineTo(cx + Math.cos(f.aim) * 420, f.y + 20 + Math.sin(f.aim) * 420);
    ctx.stroke();
    ctx.restore();
  }

  const swing = f.onGround && Math.abs(f.vx) > 0.4 ? Math.sin(f.walkT) * 5 : 0;
  const climbing = f.climbing;
  const sprite = f.isBoss
    ? f.bossImage
    : f.isPlayer && characterImages[f.character];

  if (sprite && sprite.width > 0 && sprite.height > 0) {
    const characterOption = CHARACTER_OPTIONS.find(
      (option) => option.id === f.character,
    );
    const spriteHeight = f.isBoss
      ? f.bossDrawH
      : 50 * (characterOption ? characterOption.scale || 1 : 1);
    const spriteWidth = (sprite.width / sprite.height) * spriteHeight;
    ctx.save();
    const reverseFacing = characterOption?.reverseFacing || false;
    if (f.facing > 0 !== reverseFacing) {
      ctx.translate(cx, 0);
      ctx.scale(-1, 1);
      ctx.translate(-cx, 0);
    }
    ctx.drawImage(
      sprite,
      cx - spriteWidth / 2,
      bot - spriteHeight,
      spriteWidth,
      spriteHeight,
    );
    ctx.restore();
  } else {
    // legs
    ctx.fillStyle = c.pants;
    if (climbing) {
      ctx.fillRect(cx - 9, bot - 18, 8, 18 + Math.sin(f.walkT * 2) * 3);
      ctx.fillRect(cx + 1, bot - 18, 8, 18 - Math.sin(f.walkT * 2) * 3);
    } else {
      ctx.fillRect(
        cx - 9,
        bot - 18 - Math.max(0, swing),
        8,
        18 + Math.max(0, swing) * 0.2,
      );
      ctx.fillRect(
        cx + 1,
        bot - 18 + Math.max(0, -swing),
        8,
        18 + Math.max(0, -swing) * 0.2,
      );
    }
    // shoes
    ctx.fillStyle = "#181d29";
    ctx.fillRect(
      cx - 10,
      bot - 4 + (climbing ? 0 : Math.max(0, swing) * 0.1),
      10,
      4,
    );
    ctx.fillRect(
      cx,
      bot - 4 + (climbing ? 0 : Math.max(0, -swing) * 0.1),
      10,
      4,
    );

    // torso
    ctx.fillStyle = c.shirt;
    ctx.fillRect(cx - 9, f.y + 13, 18, 17);
    ctx.fillStyle = "rgba(0,0,0,.18)";
    ctx.fillRect(cx - 9, f.y + 13, 18, 4);
    ctx.fillStyle = c.acc;
    ctx.fillRect(cx - 9, f.y + 22, 18, 3);

    // head
    ctx.fillStyle = c.skin;
    ctx.fillRect(cx - 7, f.y + 3, 14, 12);
    ctx.fillStyle = f.isPlayer ? "#d94b3a" : "#8a1d24";
    ctx.fillRect(cx - 8, f.y, 16, 5);
    ctx.fillRect(cx + (f.facing > 0 ? 4 : -8), f.y + 2, 4, 4);
  }

  // arm + weapon
  const w = WEAPONS[f.weapon];
  const sx = cx,
    sy = f.y + 19;
  if (!f.isBoss) {
    ctx.save();
    ctx.translate(sx, sy);
    ctx.rotate(f.aim);
    // arm
    ctx.fillStyle = c.skin;
    ctx.fillRect(0, -3, 14, 6);
    // gun
    ctx.fillStyle = "#2b2f3c";
    ctx.fillRect(10, -3, w.len, 6);
    ctx.fillStyle = "#4b5266";
    ctx.fillRect(10, -3, w.len, 2);
    ctx.fillStyle = "#1b1f2c";
    ctx.fillRect(12, 2, 5, 6);
    // muzzle flash
    if (f.muzzle > 0) {
      ctx.fillStyle = "rgba(255,220,130,.95)";
      ctx.beginPath();
      ctx.moveTo(w.len + 10, 0);
      ctx.lineTo(w.len + 22, -7);
      ctx.lineTo(w.len + 18, 0);
      ctx.lineTo(w.len + 22, 7);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,220,.8)";
      ctx.beginPath();
      ctx.arc(w.len + 12, 0, 4, 0, 6.29);
      ctx.fill();
    }
    ctx.restore();
  }

  // hit flash
  if (f.hitT > 0) {
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = "rgba(255,90,90," + f.hitT / 26 + ")";
    ctx.fillRect(f.x - 2, f.y - 2, f.w + 4, f.h + 4);
    ctx.globalCompositeOperation = "source-over";
  }

  // health bar for enemies
  if (!f.isPlayer && !dead) {
    const bw = f.isBoss ? Math.max(90, f.w * 1.5) : 30;
    const barY = f.isBoss ? bot - f.bossDrawH - 14 : f.y - 12;
    if (f.isBoss) {
      ctx.fillStyle = "#ffd166";
      ctx.font = '10px "Press Start 2P", monospace';
      ctx.textAlign = "center";
      ctx.fillText("BOSS WAVE " + state.wave, cx, barY - 5);
    }
    ctx.fillStyle = "rgba(0,0,0,.6)";
    ctx.fillRect(cx - bw / 2 - 1, barY, bw + 2, 7);
    ctx.fillStyle = f.isBoss ? "#ff8f2e" : "#ff4d5a";
    ctx.fillRect(cx - bw / 2, barY + 1, bw * (f.hp / f.maxHp), 5);
  }
  ctx.restore();
}

// Draws the pickup object with its icon and animation so players can identify the item.
function drawPickup(p) {
  const bob = Math.sin(p.bob) * 2;
  const x = p.x,
    y = p.y + bob;
  ctx.fillStyle = "rgba(0,0,0,.35)";
  ctx.beginPath();
  ctx.ellipse(x + 14, p.y + 30, 14, 4, 0, 0, 6.29);
  ctx.fill();
  // glow
  const gc =
    p.type === "health"
      ? "rgba(126,231,135,.20)"
      : p.type === "grenade"
        ? "rgba(255,176,122,.20)"
        : "rgba(255,209,102,.18)";
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  const g = ctx.createRadialGradient(x + 14, y + 14, 2, x + 14, y + 14, 34);
  g.addColorStop(0, gc);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x + 14, y + 14, 34, 0, 6.29);
  ctx.fill();
  ctx.restore();

  if (p.type === "health") {
    ctx.fillStyle = "#e9eef5";
    ctx.fillRect(x, y, 28, 28);
    ctx.fillStyle = "#c8d0dd";
    ctx.fillRect(x, y, 28, 5);
    ctx.fillStyle = "#e03b3b";
    ctx.fillRect(x + 11, y + 6, 6, 16);
    ctx.fillRect(x + 6, y + 11, 16, 6);
    ctx.strokeStyle = "#3a4157";
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, 26, 26);
  } else if (p.type === "grenade") {
    const grenadeType = p.grenadeType || "frag";
    const grenadeColor =
      grenadeType === "gas"
        ? "#7ee787"
        : grenadeType === "mine"
          ? "#ff6b6b"
          : "#ffb07a";
    ctx.fillStyle = grenadeType === "gas" ? "#315b36" : "#2f5a37";
    ctx.fillRect(x, y, 28, 28);
    ctx.fillStyle = grenadeColor;
    ctx.fillRect(x, y, 28, 5);
    ctx.fillStyle = grenadeColor;
    ctx.beginPath();
    ctx.arc(x + 14, y + 16, 7, 0, 6.29);
    ctx.fill();
    ctx.fillStyle = "#2b3a2c";
    ctx.font = '8px "Press Start 2P", monospace';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      grenadeType === "mine" ? "M" : grenadeType === "gas" ? "G" : "F",
      x + 14,
      y + 16,
    );
    ctx.strokeStyle = grenadeColor;
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, 26, 26);
  } else {
    const w = WEAPONS[p.weapon];
    const image = weaponImages[p.weapon];
    ctx.fillStyle = "#6b4a24";
    ctx.fillRect(x, y, 28, 28);
    ctx.fillStyle = "#8a6134";
    ctx.fillRect(x, y, 28, 5);
    ctx.strokeStyle = "#3f2c14";
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, 26, 26);
    if (image && image.complete && image.naturalWidth > 0) {
      ctx.drawImage(image, x + 3, y + 3, 22, 22);
    } else {
      ctx.fillStyle = w.color;
      ctx.font = '14px "Press Start 2P", monospace';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(w.icon, x + 14, y + 16);
    }
  }
}

// Draws the enemy direction marker and floating warning so attackers know where danger is coming from.
function drawEnemyIndicator(shakeX = 0, shakeY = 0) {
  if (
    state.scene !== "playing" ||
    state.gameMode !== "single" ||
    !player?.alive
  )
    return;

  const playerX = player.x + player.w / 2;
  const playerY = player.y + player.h / 2;
  const offscreenEnemies = [];
  for (const enemy of enemies) {
    if (!enemy.alive) continue;
    const dx = enemy.x + enemy.w / 2 - playerX;
    const dy = enemy.y + enemy.h / 2 - playerY;
    const screenLeft = (enemy.x - cam.x) * scale + shakeX;
    const screenTop = (enemy.y - cam.y) * scale + shakeY;
    const screenRight = screenLeft + enemy.w * scale;
    const screenBottom = screenTop + enemy.h * scale;
    const isVisible =
      screenRight > 0 && screenLeft < VW && screenBottom > 0 && screenTop < VH;
    if (!isVisible) offscreenEnemies.push({ dx, dy });
  }
  if (!offscreenEnemies.length) return;

  const screenX = (playerX - cam.x) * scale + shakeX;
  const screenY = (playerY - cam.y) * scale + shakeY;
  const arrowRadius = 12 + (Math.hypot(player.w, player.h) * scale) / 2;
  const firstAngle = Math.atan2(offscreenEnemies[0].dy, offscreenEnemies[0].dx);

  offscreenEnemies.forEach((enemy, index) => {
    const angle = Math.atan2(enemy.dy, enemy.dx);
    const positionAngle =
      firstAngle + (Math.PI * 2 * index) / offscreenEnemies.length;
    const arrowX = clamp(
      screenX + Math.cos(positionAngle) * arrowRadius,
      14,
      VW - 14,
    );
    const arrowY = clamp(
      screenY + Math.sin(positionAngle) * arrowRadius,
      14,
      VH - 14,
    );

    ctx.save();
    ctx.translate(arrowX, arrowY);
    ctx.rotate(angle);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    ctx.beginPath();
    ctx.moveTo(12, 0);
    ctx.lineTo(-8, -8);
    ctx.lineTo(-4, 0);
    ctx.lineTo(-8, 8);
    ctx.closePath();
    ctx.fillStyle = "#ff4d5a";
    ctx.strokeStyle = "#fff0c0";
    ctx.lineWidth = 2;
    ctx.shadowColor = "rgba(0, 0, 0, 0.9)";
    ctx.shadowBlur = 5;
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  });
}

// Renders the full game scene including the world, fighters, pickups, HUD, and overlays.
function render() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, VW, VH);
  drawSky();

  // screen shake
  let shx = 0,
    shy = 0;
  if (state.shake > 0.4) {
    shx = (Math.random() - 0.5) * state.shake;
    shy = (Math.random() - 0.5) * state.shake;
  }

  ctx.save();
  ctx.translate(shx, shy);
  ctx.scale(scale, scale);
  ctx.translate(-cam.x, -cam.y);

  drawWall();
  drawSigns();
  for (const p of PLATFORMS) drawPlatform(p);
  drawLadders();

  // props behind fighters
  for (const p of PROPS) {
    if (p.t === "jeepney") drawJeepney(p.x, p.y);
    else drawProp(p);
  }

  for (const p of pickups) drawPickup(p);
  for (const cloud of gasClouds) {
    const pulse = 0.92 + Math.sin(state.time * 0.08) * 0.06;
    const radius = cloud.radius * pulse;
    const haze = ctx.createRadialGradient(
      cloud.x,
      cloud.y,
      radius * 0.16,
      cloud.x,
      cloud.y,
      radius,
    );
    haze.addColorStop(0, "rgba(124,235,105,.32)");
    haze.addColorStop(0.72, "rgba(81,190,79,.2)");
    haze.addColorStop(1, "rgba(81,190,79,0)");
    ctx.fillStyle = haze;
    ctx.beginPath();
    ctx.arc(cloud.x, cloud.y, radius, 0, 6.29);
    ctx.fill();
  }
  for (const mine of proxyMines) {
    const armed = mine.armTimer <= 0;
    ctx.fillStyle = "rgba(0,0,0,.4)";
    ctx.beginPath();
    ctx.ellipse(mine.x, mine.y + 4, 12, 4, 0, 0, 6.29);
    ctx.fill();
    ctx.fillStyle = armed && state.time % 24 < 12 ? "#ff6b6b" : "#3e4657";
    ctx.beginPath();
    ctx.arc(mine.x, mine.y, 9, Math.PI, 0);
    ctx.lineTo(mine.x + 9, mine.y + 3);
    ctx.lineTo(mine.x - 9, mine.y + 3);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#dce3f2";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  for (const e of enemies) drawFighter(e);
  if (player) drawFighter(player);
  if (secondPlayer) drawFighter(secondPlayer);

  // grenades
  for (const g of grenades) {
    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.rotate(g.rot);
    ctx.fillStyle =
      g.type === "gas"
        ? "#7ee787"
        : g.fuse < 22 && state.time % 8 < 4
          ? "#ff8f2e"
          : "#3f5a37";
    ctx.fillRect(-5, -6, 10, 12);
    ctx.fillStyle = g.type === "gas" ? "#d7ff9d" : "#8fd88a";
    ctx.fillRect(-2, -8, 4, 3);
    ctx.restore();
  }

  // bullets
  for (const b of bullets) {
    ctx.strokeStyle = b.color;
    ctx.lineWidth = 2.2;
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - b.vx * 1.4, b.y - b.vy * 1.4);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#fff";
    ctx.fillRect(b.x - 1.5, b.y - 1.5, 3, 3);
  }

  // particles
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.life / p.max);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
  ctx.globalAlpha = 1;

  // floating score text
  ctx.textAlign = "center";
  for (const f of floaters) {
    ctx.globalAlpha = Math.min(1, f.life / 40);
    ctx.font = '10px "Press Start 2P", monospace';
    ctx.fillStyle = "rgba(0,0,0,.7)";
    ctx.fillText(f.text, f.x + 1.5, f.y + 1.5);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x, f.y);
  }
  ctx.globalAlpha = 1;

  ctx.restore();

  drawEnemyIndicator(shx, shy);

  // vignette
  const vg = ctx.createRadialGradient(
    VW / 2,
    VH / 2,
    Math.min(VW, VH) * 0.35,
    VW / 2,
    VH / 2,
    Math.max(VW, VH) * 0.78,
  );
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,.62)");
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, VW, VH);
}

/* =========================================================================
   HUD / UI
   ========================================================================= */
const hpFill = document.getElementById("hpFill");
const hpText = document.getElementById("hpText");
const scoreNum = document.getElementById("scoreNum");
const waveNum = document.getElementById("waveNum");
const enemyNum = document.getElementById("enemyNum");
const waveLabel = document.getElementById("waveLabel");
const enemyLabel = document.getElementById("enemyLabel");
const ammoMag = document.getElementById("ammoMag");
const ammoMax = document.getElementById("ammoMax");
const weaponName = document.getElementById("weaponName");
const weaponImage = document.getElementById("weaponImage");
const p2AmmoMag = document.getElementById("p2AmmoMag");
const p2AmmoMax = document.getElementById("p2AmmoMax");
const p2WeaponName = document.getElementById("p2WeaponName");
const p2WeaponImage = document.getElementById("p2WeaponImage");
const p2AmmoTap = document.getElementById("p2AmmoTap");
const ammoTap = document.getElementById("ammoTap");
const grenadeSelect = document.getElementById("grenadeSelect");
const p2GrenadeSelect = document.getElementById("p2GrenadeSelect");
const throwGrenadeBtn = document.getElementById("throwGrenadeBtn");
const hud = document.getElementById("hud");
const p2HpFill = document.getElementById("p2HpFill");
const p2HpText = document.getElementById("p2HpText");
const p2AmmoText = document.getElementById("p2AmmoText");
const p2NameTag = document.getElementById("p2Name");
const p2KillLine = document.getElementById("p2KillLine");
const hintBar = document.getElementById("hintBar");

let lastHud = {};
// HUD and scoring logic keeps the live health bar, ammo count, score, wave, and duel timer in sync with the current player state.
function updateHUD() {
  if (!player) return;
  hud.classList.toggle("duel", state.gameMode === "duel");
  waveLabel.textContent = state.gameMode === "duel" ? "TIME" : "WAVE";
  enemyLabel.textContent = state.gameMode === "duel" ? "P1 KILLS" : "ENEMIES";
  hintBar.textContent = body.classList.contains("touch-on")
    ? "LEFT STICK MOVE/JUMP · RIGHT AIM/FIRE · " +
      GRENADE_LABELS[player.grenadeType] +
      " GRENADE · FIST MELEE"
    : state.gameMode === "duel"
      ? "P1 WASD + SPACE / G THROW / Q CYCLE · P2 ARROWS + NUMPAD / 0 THROW / DECIMAL CYCLE"
      : "WASD MOVE + AIM · SPACE SHOOT · G THROW / Q CYCLE";
  const playerGrenadeText =
    GRENADE_LABELS[player.grenadeType] +
    " " +
    player.grenadeInventory[player.grenadeType];
  grenadeSelect.textContent = playerGrenadeText;
  grenadeSelect.setAttribute(
    "aria-label",
    "Selected " + playerGrenadeText + ". Tap to change grenade.",
  );
  grenadeSelect.title = "Tap to change grenade";
  throwGrenadeBtn.setAttribute(
    "aria-label",
    "Throw " + GRENADE_LABELS[player.grenadeType] + " Grenade",
  );
  if (secondPlayer) {
    p2NameTag.textContent = p2PlayerName.toUpperCase();
    const hp2 = Math.max(0, Math.round(secondPlayer.hp));
    p2HpFill.style.width = (hp2 / secondPlayer.maxHp) * 100 + "%";
    p2HpText.textContent = hp2;
    const p2Weapon = WEAPONS[secondPlayer.weapon];
    p2WeaponName.textContent = p2Weapon.name;
    p2WeaponImage.src = p2Weapon.image;
    p2WeaponImage.alt = p2Weapon.name;
    p2WeaponImage.title = secondPlayer.secondaryWeapon
      ? "Tap to switch to " + WEAPONS[secondPlayer.secondaryWeapon].name
      : "No secondary weapon";
    p2AmmoMag.textContent = secondPlayer.reloading ? "··" : secondPlayer.mag;
    p2AmmoMax.textContent = p2Weapon.mag;
    p2AmmoMag.parentElement.classList.toggle(
      "empty",
      secondPlayer.mag <= 0 && !secondPlayer.reloading,
    );
    const p2GrenadeText =
      GRENADE_LABELS[secondPlayer.grenadeType] +
      " " +
      secondPlayer.grenadeInventory[secondPlayer.grenadeType];
    p2GrenadeSelect.textContent = p2GrenadeText;
    p2GrenadeSelect.setAttribute(
      "aria-label",
      "Player 2 selected " + p2GrenadeText + ". Tap to change grenade.",
    );
    p2GrenadeSelect.title = "Tap to change grenade";
    p2AmmoText.textContent =
      p2Weapon.name +
      " " +
      (secondPlayer.reloading ? "··" : secondPlayer.mag) +
      "/" +
      p2Weapon.mag +
      " · " +
      p2GrenadeText;
  }
  const hp = Math.max(0, Math.round(player.hp));
  if (lastHud.hp !== hp) {
    hpFill.style.width = (hp / player.maxHp) * 100 + "%";
    hpFill.className = "hp-fill" + (hp > 60 ? "" : hp > 30 ? " mid" : " low");
    hpText.textContent = hp;
    lastHud.hp = hp;
  }
  if (lastHud.score !== state.score) {
    scoreNum.textContent = state.score;
    lastHud.score = state.score;
  }
  if (state.gameMode === "duel") {
    const secondsLeft = Math.ceil(state.duelTimeFrames / 60);
    waveNum.textContent =
      Math.floor(secondsLeft / 60) +
      ":" +
      String(secondsLeft % 60).padStart(2, "0");
    enemyNum.textContent = state.p1Kills;
    p2KillLine.textContent = "P2 KILLS " + state.p2Kills;
  } else if (lastHud.wave !== state.wave) {
    waveNum.textContent = Math.max(1, state.wave);
    lastHud.wave = state.wave;
  }
  if (state.gameMode === "single") {
    const alive = enemies.filter((e) => e.alive).length;
    if (lastHud.enemies !== alive) {
      enemyNum.textContent = alive;
      lastHud.enemies = alive;
    }
  }
  const w = WEAPONS[player.weapon];
  if (lastHud.weapon !== player.weapon) {
    weaponName.textContent = w.name;
    weaponImage.src = w.image;
    weaponImage.alt = w.name;
    ammoMax.textContent = w.mag;
    lastHud.weapon = player.weapon;
  }
  weaponImage.title = player.secondaryWeapon
    ? "Tap to switch to " + WEAPONS[player.secondaryWeapon].name
    : "No secondary weapon";
  p2AmmoTap.title = secondPlayer ? "Tap to reload" : "";
  const mag = player.reloading ? "··" : player.mag;
  if (lastHud.mag !== mag) {
    ammoMag.textContent = mag;
    lastHud.mag = mag;
  }
  ammoMag.parentElement.classList.toggle(
    "empty",
    player.mag <= 0 && !player.reloading,
  );
}

let toastT = null;
// Displays a short transient toast message to communicate score, mode, or pickup events.
function showToast(msg) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("on");
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove("on"), 1800);
}

// Shows or hides a named overlay panel for menus, alerts, and game-state transitions.
function showOverlay(id, on) {
  const el = document.getElementById(id);
  if (on) {
    el.classList.remove("hidden");
    requestAnimationFrame(() => el.classList.add("on"));
  } else {
    el.classList.remove("on");
    setTimeout(() => {
      if (!el.classList.contains("on")) el.classList.add("hidden");
    }, 220);
  }
}
// Closes every visible overlay so the game can return to the main play state cleanly.
function hideAllOverlays() {
  ["menuOv", "modeOv", "overOv", "lbOv", "pauseOv"].forEach((id) =>
    showOverlay(id, false),
  );
}

/* =========================================================================
   GAME FLOW
   ========================================================================= */
// Solo-player game flow resets the map, player stats, and enemy waves before starting a fresh run.
function startGame() {
  if (!isLandscape()) return;
  applySelectedMap();
  audio(); // unlock audio on user gesture
  state.scene = "playing";
  state.score = 0;
  state.wave = 0;
  state.kills = 0;
  state.shots = 0;
  state.hits = 0;
  state.shake = 0;
  state.remaining = 0;
  state.spawnCd = 0;
  state.waveBreak = 0;
  state.duelEndScheduled = false;
  state.duelTimeFrames = state.gameMode === "duel" ? 300 * 60 : 0;
  state.p1Kills = 0;
  state.p2Kills = 0;
  state.p1RespawnFrames = 0;
  state.p2RespawnFrames = 0;
  state.randomDropFrames = Math.round(rand(12 * 60, 18 * 60));
  bullets.length = 0;
  particles.length = 0;
  enemies.length = 0;
  grenades.length = 0;
  gasClouds.length = 0;
  proxyMines.length = 0;
  floaters.length = 0;
  pickups.length = 0;
  secondPlayer = null;
  player =
    state.gameMode === "duel"
      ? makePlayer(760, GROUND_Y - 60)
      : makePlayer(320, GROUND_Y - 60);
  if (state.gameMode === "duel") {
    player.facing = 1;
    secondPlayer = makePlayer(
      1420,
      GROUND_Y - 60,
      selectedP2Character,
      true,
      p2PlayerName,
    );
    secondPlayer.facing = -1;
    secondPlayer.aim = Math.PI;
    const startingWeapons = ["smg", "shotgun", "rifle"];
    dropPickup(
      1090,
      GROUND_Y - 18,
      "weapon",
      startingWeapons[(Math.random() * startingWeapons.length) | 0],
    );
  }
  document.getElementById("pName").textContent = (
    state.playerName || "PLAYER"
  ).toUpperCase();
  document.getElementById("p2Name").textContent = p2PlayerName.toUpperCase();
  if (state.gameMode === "single") spawnInitialPickups();
  camFollow(player, true);
  if (state.gameMode === "single") nextWave();
  lastHud = {};
  updateHUD();
  hideAllOverlays();
  hud.classList.add("on");
  document
    .getElementById("saveBtn")
    .classList.toggle("hidden", state.gameMode === "duel");
  document
    .getElementById("singlePlayerResults")
    .classList.toggle("hidden", state.gameMode === "duel");
}

// Toggles the pause state and opens or closes the pause overlay for the current match.
function togglePause() {
  if (state.scene === "playing") {
    state.scene = "paused";
    showOverlay("pauseOv", true);
  } else if (state.scene === "paused") {
    state.scene = "playing";
    showOverlay("pauseOv", false);
  }
}

// Displays the end-of-run game-over screen and prepares the score submission flow.
function showGameOver() {
  document.getElementById("overTitle").textContent = "YOU WERE DOWNED";
  document.getElementById("overSub").textContent =
    "The barangay will remember your stand.";
  document.getElementById("singlePlayerResults").classList.remove("hidden");
  document.getElementById("saveBtn").classList.remove("hidden");
  const acc =
    state.shots > 0 ? Math.round((state.hits / state.shots) * 100) : 0;
  document.getElementById("overScore").textContent = state.score;
  document.getElementById("overWave").textContent = Math.max(1, state.wave);
  document.getElementById("overKills").textContent = state.kills;
  document.getElementById("overAcc").textContent = acc + "%";
  document.getElementById("overName").value = state.playerName || "";
  document.getElementById("saveMsg").textContent = "";
  document.getElementById("saveBtn").disabled = false;
  document.getElementById("saveBtn").textContent = "💾 SUBMIT SCORE";
  showOverlay("overOv", true);
  submitScore();
}

// Displays the duel winner screen and summarizes the result of the one-on-one match.
function showDuelGameOver(winner) {
  document.getElementById("overTitle").textContent =
    winner === "DRAW" ? "DRAW!" : winner + " WINS!";
  document.getElementById("overSub").textContent =
    "FINAL KILLS — " +
    state.playerName.toUpperCase() +
    ": " +
    state.p1Kills +
    " · " +
    p2PlayerName.toUpperCase() +
    ": " +
    state.p2Kills;
  document.getElementById("overScore").textContent =
    winner === "DRAW" ? "TIED MATCH" : winner + " WINS";
  document.getElementById("singlePlayerResults").classList.add("hidden");
  document.getElementById("saveBtn").classList.add("hidden");
  showOverlay("overOv", true);
}

// Sends the final score to the leaderboard and updates the UI with the result and rank.
async function submitScore() {
  const nameEl = document.getElementById("overName");
  const name = (nameEl.value || "").trim();
  if (!name) {
    document.getElementById("saveMsg").textContent =
      "Enter a fighter name before playing.";
    nameEl.focus();
    return;
  }
  state.playerName = name;
  try {
    localStorage.setItem("sf.name", name);
  } catch (e) {}
  const btn = document.getElementById("saveBtn");
  btn.disabled = true;
  btn.textContent = "SAVING…";
  document.getElementById("saveMsg").textContent = "Contacting game.db…";
  const res = await api("POST", "/api/scores", {
    name,
    score: state.score,
    wave: Math.max(1, state.wave),
  });
  if (res && res.ok) {
    if (res.data.updated) {
      document.getElementById("saveMsg").innerHTML =
        'New personal best saved! Rank <b style="color:#ffd166">#' +
        res.data.rank +
        "</b> of " +
        res.data.total +
        " fighters.";
      btn.textContent = "✔ PERSONAL BEST";
    } else if (res.data.existing) {
      document.getElementById("saveMsg").innerHTML =
        'Personal best remains <b style="color:#ffd166">' +
        res.data.score +
        "</b> (rank #" +
        res.data.rank +
        ").";
      btn.textContent = "✔ BEST KEPT";
    } else {
      document.getElementById("saveMsg").innerHTML =
        'Saved! Rank <b style="color:#ffd166">#' +
        res.data.rank +
        "</b> of " +
        res.data.total +
        " fighters.";
      btn.textContent = "✔ SAVED";
    }
    refreshLeaderboard(res.data.id);
  } else {
    document.getElementById("saveMsg").textContent =
      "Could not save — try again.";
    btn.disabled = false;
    btn.textContent = "💾 SUBMIT SCORE";
  }
}

// Updates the online/offline badge so players know whether the leaderboard is connected to a backend.
function setBadge(online) {
  const b = document.getElementById("lbBadge");
  b.textContent = online ? "ONLINE SERVER" : "LOCAL DB (game.db)";
  b.className = "badge pixel" + (online ? "" : " off");
}

// Reloads the leaderboard data and highlights the current player when a score is updated.
async function refreshLeaderboard(highlightId) {
  const body = document.getElementById("lbBody");
  body.innerHTML = '<tr><td colspan="5" class="sub">Loading…</td></tr>';
  const [scores, stats] = await Promise.all([
    api("GET", "/api/scores?limit=10"),
    api("GET", "/api/stats"),
  ]);
  if (!scores.ok) {
    body.innerHTML =
      '<tr><td colspan="5" class="sub">Error loading scores.</td></tr>';
    return;
  }
  if (!scores.data.length) {
    body.innerHTML =
      '<tr><td colspan="5" class="sub">No scores yet — be the first legend.</td></tr>';
  } else {
    body.innerHTML = scores.data
      .map((r, i) => {
        const me = highlightId && r.id === highlightId ? ' class="me"' : "";
        const d = new Date(r.createdAt);
        const ds = d.getMonth() + 1 + "/" + d.getDate();
        const medals = ["🥇", "🥈", "🥉"];
        const rk = i < 3 ? medals[i] : i + 1;
        return (
          "<tr" +
          me +
          '><td class="rank">' +
          rk +
          "</td><td>" +
          escapeHtml(r.name) +
          '</td><td style="color:#ffd166">' +
          r.score.toLocaleString() +
          "</td><td>" +
          r.wave +
          '</td><td style="color:#8b95b5">' +
          ds +
          "</td></tr>"
        );
      })
      .join("");
  }
  if (stats.ok) {
    document.getElementById("lbStats").innerHTML =
      "<span>MATCHES PLAYED <b>" +
      stats.data.games +
      "</b></span>" +
      "<span>FIGHTERS <b>" +
      stats.data.players +
      "</b></span>" +
      "<span>HIGH SCORE <b>" +
      stats.data.best.toLocaleString() +
      "</b></span>";
    document.getElementById("menuStats").innerHTML =
      "<span>MATCHES PLAYED <b>" +
      stats.data.games +
      "</b></span>" +
      "<span>HIGH SCORE <b>" +
      stats.data.best.toLocaleString() +
      "</b></span>" +
      "<span>DB <b>" +
      (useRealServer ? "SERVER" : "LOCAL game.db") +
      "</b></span>";
  }
}
// Escapes unsafe HTML characters before inserting a name or message into the leaderboard UI.
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

/* =========================================================================
   INPUT — KEYBOARD + MOUSE
   ========================================================================= */
// Keyboard controls for Player 1 and Player 2: WASD/arrow keys move and aim, R reloads, E picks up loot,
// G and Numpad 0 throw grenades, Q and Numpad Decimal cycle grenades, and Space/Numpad 5 fire the active weapon.
window.addEventListener("keydown", (e) => {
  if (
    [
      "Space",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Numpad8",
      "Numpad6",
      "Numpad4",
      "Numpad2",
      "Numpad5",
      "NumpadAdd",
      "NumpadDecimal",
      "KeyQ",
    ].includes(e.code)
  )
    e.preventDefault();
  if (e.repeat) {
    keys[e.code] = true;
    return;
  }
  keys[e.code] = true;

  if (state.scene === "playing") {
    if (e.code === "KeyR" && player) startReload(player);
    if (e.code === "KeyE" && player) tryPickup(player);
    if (e.code === "KeyQ" && player) cycleGrenade(player);
    if (e.code === "NumpadDecimal" && secondPlayer) cycleGrenade(secondPlayer);
    if (
      (e.code === "NumpadAdd" || e.key === "+") &&
      state.gameMode === "duel" &&
      secondPlayer
    )
      tryPickup(secondPlayer);
    if (e.code === "KeyG" && player) throwGrenade(player);
    if (e.code === "Numpad0" && secondPlayer) throwGrenade(secondPlayer);
  }
  if (e.code === "Escape") {
    if (state.scene === "playing" || state.scene === "paused") togglePause();
  }
});
window.addEventListener("keyup", (e) => {
  keys[e.code] = false;
});

cvs.addEventListener("mousemove", (e) => {
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  mouse.active = true;
});
cvs.addEventListener("mousedown", (e) => {
  mouse.down = true;
  mouse.x = e.clientX;
  mouse.y = e.clientY;
  mouse.active = true;
});
window.addEventListener("mouseup", () => {
  mouse.down = false;
});
cvs.addEventListener("mouseleave", () => {
  mouse.down = false;
});
cvs.addEventListener("contextmenu", (e) => e.preventDefault());

/* =========================================================================
   INPUT — TOUCH
   ========================================================================= */
// Mobile controls use two joystick zones: the left stick drives movement and jump input, while the right stick
// controls aiming and firing direction. This keeps the game usable on phones without a keyboard or mouse.
const body = document.body;
const touch = {
  move: { active: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0, mag: 0 },
  aim: {
    active: false,
    id: null,
    ox: 0,
    oy: 0,
    dx: 0,
    dy: 0,
    mag: 0,
    fired: false,
  },
};
const stickMoveEl = document.getElementById("stickMove");
const stickAimEl = document.getElementById("stickAim");
const zoneL = document.getElementById("zoneL");
const zoneR = document.getElementById("zoneR");
const RADIUS = 56;

// Draws the touch joystick thumb and base according to the current drag position and origin.
function setStickVisual(el, t, origin) {
  if (t.active) {
    el.classList.add("on");
    el.style.left = origin.x + "px";
    el.style.top = origin.y + "px";
    const knob = el.querySelector(".knob");
    knob.style.transform =
      "translate(" + t.dx * RADIUS + "px," + t.dy * RADIUS + "px)";
  } else {
    el.classList.remove("on");
  }
}

// Begins a touch drag for a joystick and records the pointer position so movement can track the input.
function startStick(t, el, e, originX, originY) {
  t.active = true;
  t.id = e.pointerId;
  t.ox = originX;
  t.oy = originY;
  t.dx = 0;
  t.dy = 0;
  t.mag = 0;
  if (t === touch.aim) t.fired = false;
  el.classList.add("on");
  el.style.left = originX + "px";
  el.style.top = originY + "px";
  el.querySelector(".knob").style.transform = "translate(0px,0px)";
  try {
    el.setPointerCapture(e.pointerId);
  } catch (err) {}
}

// Updates the joystick visual and movement direction while the player drags the control.
function moveStick(t, el, e) {
  if (!t.active || t.id !== e.pointerId) return;
  let dx = e.clientX - t.ox,
    dy = e.clientY - t.oy;
  const len = Math.hypot(dx, dy);
  const clamped = Math.min(len, RADIUS);
  if (len > 0) {
    dx = dx / len;
    dy = dy / len;
  } else {
    dx = 0;
    dy = 0;
  }
  t.dx = dx * (clamped / RADIUS);
  t.dy = dy * (clamped / RADIUS);
  t.mag = clamped / RADIUS;
  el.querySelector(".knob").style.transform =
    "translate(" + dx * clamped + "px," + dy * clamped + "px)";
}

// Ends the touch drag and resets the joystick to the neutral state when the player releases input.
function endStick(t, el, e) {
  if (!t.active || (e && t.id !== e.pointerId)) return;
  t.active = false;
  t.id = null;
  t.dx = 0;
  t.dy = 0;
  t.mag = 0;
  el.classList.remove("on");
}

zoneL.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (touch.move.active) return;
  startStick(touch.move, stickMoveEl, e, e.clientX, e.clientY);
});
zoneR.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (touch.aim.active) return;
  startStick(touch.aim, stickAimEl, e, e.clientX, e.clientY);
});
window.addEventListener(
  "pointermove",
  (e) => {
    moveStick(touch.move, stickMoveEl, e);
    moveStick(touch.aim, stickAimEl, e);
  },
  { passive: true },
);
window.addEventListener("pointerup", (e) => {
  if (touch.move.id === e.pointerId) {
    endStick(touch.move, stickMoveEl, e);
  }
  if (touch.aim.id === e.pointerId) {
    const shouldFire =
      touch.aim.mag > 0.18 && !touch.aim.fired && player && player.alive;
    endStick(touch.aim, stickAimEl, e);
    if (shouldFire) fireWeapon(player);
  }
});
window.addEventListener("pointercancel", (e) => {
  if (touch.move.id === e.pointerId) endStick(touch.move, stickMoveEl, e);
  if (touch.aim.id === e.pointerId) endStick(touch.aim, stickAimEl, e);
});

document.querySelectorAll(".tbtn").forEach((btn) => {
  const act = btn.dataset.act;
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    btn.classList.add("press");
    if (!player || !player.alive) return;
    if (act === "pick") tryPickup();
    if (act === "nade") throwGrenade(player);
    if (act === "melee") meleeAttack(player);
  });
  btn.addEventListener("pointerup", (e) => {
    btn.classList.remove("press");
  });
  btn.addEventListener("pointercancel", () => {
    btn.classList.remove("press");
  });
});
weaponImage.addEventListener("click", () => switchWeapon(player));
ammoTap.addEventListener("click", () => startReload(player));
grenadeSelect.addEventListener("click", () => cycleGrenade(player));
p2GrenadeSelect.addEventListener("click", () => cycleGrenade(secondPlayer));
p2WeaponImage.addEventListener("click", () => switchWeapon(secondPlayer));
p2AmmoTap.addEventListener("click", () => startReload(secondPlayer));

let touchMode = "auto";
// Detects whether the player is using a touch device so mobile-friendly controls can be enabled.
function detectTouch() {
  const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  if (touchMode === "on") body.classList.add("touch-on");
  else if (touchMode === "off") body.classList.remove("touch-on");
  else body.classList.toggle("touch-on", isTouch);
  document.getElementById("touchToggle").textContent =
    "📱 TOUCH: " +
    (touchMode === "auto"
      ? isTouch
        ? "AUTO (ON)"
        : "AUTO (OFF)"
      : touchMode.toUpperCase());
  if (player) updateHUD();
}
detectTouch();
window.addEventListener(
  "touchstart",
  () => {
    if (touchMode === "auto") {
      body.classList.add("touch-on");
      if (player) updateHUD();
    }
  },
  { once: true, passive: true },
);

/* =========================================================================
   UI WIRING
   ========================================================================= */
const nameInput = document.getElementById("nameInput");
const mapPicker = document.getElementById("mapPicker");
const characterPicker = document.getElementById("characterPicker");
const characterPreview = document.getElementById("characterPreview");
const characterName = document.getElementById("characterName");
const p2CharacterPreview = document.getElementById("p2CharacterPreview");
const p2CharacterName = document.getElementById("p2CharacterName");
const p2CharacterSection = document.getElementById("p2CharacterSection");
const controlHint = document.getElementById("controlHint");
const p2NameInput = document.getElementById("p2NameInput");
// Character selection and map selection are driven through these helpers so the chosen skin and arena update the preview immediately before the match starts.
function updateCharacterPicker() {
  const character = CHARACTER_OPTIONS.find(
    (option) => option.id === selectedCharacter,
  );
  characterPreview.src = character.file;
  characterName.textContent = character.label;
  const p2Character = CHARACTER_OPTIONS.find(
    (option) => option.id === selectedP2Character,
  );
  p2CharacterPreview.src = p2Character.file;
  p2CharacterName.textContent = p2Character.label;
}
// Advances the selected player character by a direction offset and updates the preview state.
function chooseCharacter(offset) {
  const currentIndex = CHARACTER_OPTIONS.findIndex(
    (option) => option.id === selectedCharacter,
  );
  const nextIndex =
    (currentIndex + offset + CHARACTER_OPTIONS.length) %
    CHARACTER_OPTIONS.length;
  selectedCharacter = CHARACTER_OPTIONS[nextIndex].id;
  updateCharacterPicker();
  try {
    localStorage.setItem("sf.character", selectedCharacter);
  } catch (e) {}
}
// Advances the second player character choice in the duel mode selection UI.
function chooseP2Character(offset) {
  const currentIndex = CHARACTER_OPTIONS.findIndex(
    (option) => option.id === selectedP2Character,
  );
  const nextIndex =
    (currentIndex + offset + CHARACTER_OPTIONS.length) %
    CHARACTER_OPTIONS.length;
  selectedP2Character = CHARACTER_OPTIONS[nextIndex].id;
  updateCharacterPicker();
  try {
    localStorage.setItem("sf.character.p2", selectedP2Character);
  } catch (e) {}
}
// Game-mode switching toggles between solo survival and 1v1 duel mode, updating the HUD and control hints to match the selected play style.
function setGameMode(mode) {
  state.gameMode = mode;
  const duel = mode === "duel";
  p2CharacterSection.classList.toggle("hidden", !duel);
  controlHint.innerHTML = duel
    ? "<span>PLAYER 1: WASD MOVE + AIM · SPACE FIRE · G GRENADE · Q CYCLE GRENADE | PLAYER 2: ARROWS MOVE · NUMPAD 8/6/4/2 AIM · 5 FIRE · 0 GRENADE · DECIMAL CYCLE</span>"
    : "<span>WASD MOVE + AIM · E PICK UP · R RELOAD · G GRENADE · Q CYCLE GRENADE · SPACE FIRE</span>";
}
// Map selection swaps the platform geometry, ladders, and scenery so each stage has its own layout and traversal routes.
function selectMap(mapId) {
  selectedMapId = mapId;
  applySelectedMap();
  mapPicker.querySelectorAll(".map-choice").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.map === mapId));
  });
  try {
    localStorage.setItem("sf.map", mapId);
  } catch (e) {}
}
mapPicker.querySelectorAll(".map-choice").forEach((button) => {
  button.addEventListener("click", () => selectMap(button.dataset.map));
  button.setAttribute(
    "aria-pressed",
    String(button.dataset.map === selectedMapId),
  );
});
applySelectedMap();
// Player-name storage keeps the selected P1 and P2 names stable between launches so the menu and score screen remain consistent.
function savePlayerNames() {
  state.playerName = (nameInput.value || "").trim().slice(0, 14) || "PLAYER 1";
  p2PlayerName = (p2NameInput.value || "").trim().slice(0, 14) || "PLAYER 2";
  try {
    localStorage.setItem("sf.name", state.playerName);
    localStorage.setItem("sf.name.p2", p2PlayerName);
  } catch (e) {}
}
// Opens the mode selection menu so the player can choose a play style or match type.
function openModePicker() {
  savePlayerNames();
  showOverlay("menuOv", false);
  showOverlay("modeOv", true);
}
document
  .getElementById("characterPrev")
  .addEventListener("click", () => chooseCharacter(-1));
document
  .getElementById("characterNext")
  .addEventListener("click", () => chooseCharacter(1));
document
  .getElementById("p2CharacterPrev")
  .addEventListener("click", () => chooseP2Character(-1));
document
  .getElementById("p2CharacterNext")
  .addEventListener("click", () => chooseP2Character(1));
document.getElementById("singleModeBtn").addEventListener("click", () => {
  setGameMode("single");
  startGame();
});
document
  .getElementById("duelModeBtn")
  .addEventListener("click", () => setGameMode("duel"));
updateCharacterPicker();
try {
  state.playerName = localStorage.getItem("sf.name") || "";
  p2PlayerName = localStorage.getItem("sf.name.p2") || "PLAYER 2";
} catch (e) {}
nameInput.value = state.playerName;
p2NameInput.value = p2PlayerName;

document.getElementById("playBtn").addEventListener("click", openModePicker);
document.getElementById("startDuelBtn").addEventListener("click", () => {
  savePlayerNames();
  setGameMode("duel");
  startGame();
});
document.getElementById("modeBackBtn").addEventListener("click", () => {
  showOverlay("modeOv", false);
  showOverlay("menuOv", true);
});
document.getElementById("lbBtn").addEventListener("click", () => {
  showOverlay("lbOv", true);
  refreshLeaderboard();
});
document
  .getElementById("lbClose")
  .addEventListener("click", () => showOverlay("lbOv", false));

document.getElementById("pauseBtn").addEventListener("click", () => {
  if (state.scene === "playing") togglePause();
});
document
  .getElementById("resumeBtn")
  .addEventListener("click", () => togglePause());
document.getElementById("quitBtn").addEventListener("click", () => {
  state.scene = "menu";
  hud.classList.remove("on");
  showOverlay("pauseOv", false);
  showOverlay("menuOv", true);
  refreshLeaderboard();
});
document.getElementById("touchToggle").addEventListener("click", () => {
  touchMode = touchMode === "auto" ? "on" : touchMode === "on" ? "off" : "auto";
  detectTouch();
});
document.getElementById("soundToggle").addEventListener("click", (e) => {
  state.sound = !state.sound;
  e.target.textContent = state.sound ? "🔊 SOUND: ON" : "🔇 SOUND: OFF";
});
document.getElementById("saveBtn").addEventListener("click", submitScore);
document.getElementById("againBtn").addEventListener("click", () => {
  showOverlay("overOv", false);
  setTimeout(startGame, 220);
});
document.getElementById("overMenuBtn").addEventListener("click", () => {
  state.scene = "menu";
  hud.classList.remove("on");
  showOverlay("overOv", false);
  showOverlay("menuOv", true);
  refreshLeaderboard();
});
document.getElementById("overName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitScore();
  e.stopPropagation();
});
nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    openModePicker();
  }
  e.stopPropagation();
});
p2NameInput.addEventListener("keydown", (e) => {
  e.stopPropagation();
});

/* =========================================================================
   BOOT
   ========================================================================= */
// Initializes the game setup, assets, UI state, and leaderboard connection before the first frame starts.
async function boot() {
  await probeServer();
  setBadge(useRealServer);
  await refreshLeaderboard();
  // idle demo camera behind the menu
  requestAnimationFrame(() => {
    cam.x = 300;
    cam.y = 200;
  });
}
boot();

let last = performance.now(),
  acc = 0;
const STEP = 1000 / 60;

// Runs the animation loop and advances the game logic and rendering on each frame.
function loop(now) {
  requestAnimationFrame(loop);
  if (!isLandscape() && state.scene === "playing") {
    state.scene = "paused";
    orientationPaused = true;
  } else if (isLandscape() && orientationPaused) {
    state.scene = "playing";
    orientationPaused = false;
  }
  let dt = now - last;
  last = now;
  if (dt > 220) dt = 220;
  acc += dt;
  let guard = 0;
  while (acc >= STEP && guard < 6) {
    acc -= STEP;
    guard++;
    if (state.scene === "playing") {
      update();
    } else if (state.scene === "menu") {
      state.time++;
      cam.x += 0.18;
      if (cam.x > WORLD.w - viewW() - 40) cam.x = 60;
      cam.y = Math.max(0, Math.min(WORLD.h - viewH(), 360));
      updateParticles();
      if (Math.random() < 0.02) updateFloaters();
    } else if (state.scene === "dead" || state.scene === "paused") {
      state.time++;
      updateParticles();
      updateFloaters();
    }
  }
  // playing/dying render uses live entities; menu renders too so the world shows behind overlays
  if (state.scene === "menu" && !brickPattern) brickPattern = makeBrick();
  render();
}
requestAnimationFrame(loop);

// prevent iOS double-tap zoom & pull-to-refresh
document.addEventListener("gesturestart", (e) => e.preventDefault());
document.addEventListener(
  "touchmove",
  (e) => {
    if (e.touches.length > 1) e.preventDefault();
  },
  { passive: false },
);
