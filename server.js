import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const http = createServer(app);
const io = new Server(http);
app.get("/", (_req, res) => res.sendFile(join(__dirname, "index.html")));

// ---------- config ----------
const START_MONEY = 20;
const BID_STEP = 0.5;
const TEAM_SIZE = 6;
const POOL_SIZE = TEAM_SIZE * 2; // every Pokémon drawn ends up on a team
const EXACT_GUESS_BONUS = 1;

// National Pokédex ranges per generation
const GENS = {
  all: [1, 1025],
  1: [1, 151], 2: [152, 251], 3: [252, 386], 4: [387, 493],
  5: [494, 649], 6: [650, 721], 7: [722, 809], 8: [810, 905], 9: [906, 1025],
};

// ---------- PokéAPI ----------
const cache = new Map();
async function fetchPokemon(id) {
  if (cache.has(id)) return cache.get(id);
  const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${id}`);
  if (!res.ok) throw new Error(`PokéAPI ${id}: ${res.status}`);
  const d = await res.json();
  const p = {
    id: d.id,
    name: d.name.replace(/-/g, " "),
    sprite:
      d.sprites.other?.["official-artwork"]?.front_default || d.sprites.front_default,
    types: d.types.map((t) => t.type.name),
    stats: Object.fromEntries(d.stats.map((s) => [s.stat.name, s.base_stat])),
  };
  cache.set(id, p);
  return p;
}

function randomIds(gen, n) {
  const [lo, hi] = GENS[gen] || GENS.all;
  const ids = new Set();
  while (ids.size < n) ids.add(lo + Math.floor(Math.random() * (hi - lo + 1)));
  return [...ids];
}

// ---------- rooms ----------
const rooms = new Map();
const code = () => randomBytes(3).toString("hex").toUpperCase();

function newRoom(gen) {
  const room = {
    code: code(),
    gen: GENS[gen] ? gen : "all",
    phase: "lobby", // lobby | loading | bidding | reveal | tiebreak | done
    players: [], // { id, name, money, team: [], socket }
    pool: [],
    round: 0,
    bids: {},
    reveal: null,
    tiebreak: null, // { target, range, guesses }
    log: [],
  };
  rooms.set(room.code, room);
  return room;
}

function publicState(room, viewerId) {
  const other = (p) => p.id !== viewerId;
  return {
    code: room.code,
    gen: room.gen,
    phase: room.phase,
    round: room.round,
    poolSize: room.pool.length,
    current: room.phase === "bidding" || room.phase === "tiebreak" ? room.pool[room.round] : null,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      money: p.money,
      team: p.team,
      connected: !!p.socket,
      hasBid: room.bids[p.id] !== undefined,
      hasGuessed: room.tiebreak?.guesses[p.id] !== undefined,
      you: p.id === viewerId,
    })),
    tiebreak: room.tiebreak ? { range: room.tiebreak.range } : null,
    reveal: room.reveal,
    log: room.log.slice(-12),
  };
}

function broadcast(room) {
  for (const p of room.players)
    if (p.socket) p.socket.emit("state", publicState(room, p.id));
}

function say(room, text) {
  room.log.push(text);
}

// ---------- game flow ----------
async function startGame(room) {
  room.phase = "loading";
  broadcast(room);
  try {
    room.pool = await Promise.all(randomIds(room.gen, POOL_SIZE).map(fetchPokemon));
  } catch (e) {
    room.phase = "lobby";
    say(room, `Couldn't load Pokémon (${e.message}). Try again.`);
    return broadcast(room);
  }
  room.round = 0;
  room.phase = "bidding";
  say(room, `Draft started — ${POOL_SIZE} Pokémon, £${START_MONEY} each.`);
  broadcast(room);
}

function validBid(player, amount) {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return false;
  if (amount < 0 || amount > player.money) return false;
  return Math.abs(amount / BID_STEP - Math.round(amount / BID_STEP)) < 1e-9;
}

function resolveBids(room) {
  const [a, b] = room.players;
  const ba = room.bids[a.id], bb = room.bids[b.id];
  const mon = room.pool[room.round];
  room.reveal = { pokemon: mon, bids: { [a.id]: ba, [b.id]: bb }, winnerId: null, reason: null };

  if (ba !== bb) {
    const winner = ba > bb ? a : b;
    award(room, winner, mon, Math.max(ba, bb), "outbid");
  } else {
    // sealed tie → guess-the-Pokédex-number tiebreak
    const [lo, hi] = GENS[room.gen];
    room.tiebreak = { target: lo + Math.floor(Math.random() * (hi - lo + 1)), range: [lo, hi], guesses: {} };
    room.phase = "tiebreak";
    say(room, `Both bid £${ba.toFixed(2)} for ${mon.name}. Tiebreak: guess the hidden Pokédex number.`);
  }
  broadcast(room);
}

function resolveTiebreak(room) {
  const [a, b] = room.players;
  const t = room.tiebreak;
  const ga = t.guesses[a.id], gb = t.guesses[b.id];
  const da = Math.abs(ga - t.target), db = Math.abs(gb - t.target);
  const mon = room.pool[room.round];
  const price = room.bids[a.id];

  let winner, reason;
  if (da !== db) { winner = da < db ? a : b; reason = "closer guess"; }
  else { winner = Math.random() < 0.5 ? a : b; reason = "coin flip"; }

  room.reveal.tiebreak = { target: t.target, guesses: { [a.id]: ga, [b.id]: gb }, reason };
  for (const p of [a, b]) {
    if (t.guesses[p.id] === t.target) {
      p.money += EXACT_GUESS_BONUS;
      say(room, `${p.name} guessed #${t.target} exactly — +£${EXACT_GUESS_BONUS}.`);
    }
  }
  room.tiebreak = null;
  award(room, winner, mon, price, reason);
  broadcast(room);
}

function award(room, winner, mon, price, reason) {
  winner.money = +(winner.money - price).toFixed(2);
  winner.team.push(mon);
  room.reveal.winnerId = winner.id;
  room.reveal.reason = reason;
  say(room, `${winner.name} wins ${mon.name} for £${price.toFixed(2)} (${reason}).`);
  room.bids = {};
  room.phase = "reveal";

  // one team full → the rest go free to the other player
  const full = room.players.find((p) => p.team.length >= TEAM_SIZE);
  if (full) {
    const other = room.players.find((p) => p !== full);
    const leftovers = room.pool.slice(room.round + 1);
    other.team.push(...leftovers);
    if (leftovers.length)
      say(room, `${full.name} has a full team. ${other.name} gets ${leftovers.map((m) => m.name).join(", ")} for free.`);
    room.phase = "done";
    say(room, "Draft complete.");
  }
}

function nextRound(room) {
  room.round += 1;
  room.reveal = null;
  if (room.round >= room.pool.length) {
    room.phase = "done";
    say(room, "Draft complete.");
  } else {
    room.phase = "bidding";
  }
  broadcast(room);
}

// ---------- sockets ----------
io.on("connection", (socket) => {
  let room = null, me = null;

  socket.on("create", ({ name, gen }, cb) => {
    room = newRoom(gen);
    me = { id: randomBytes(8).toString("hex"), name: clean(name), money: START_MONEY, team: [], socket };
    room.players.push(me);
    cb({ code: room.code, playerId: me.id });
    broadcast(room);
  });

  socket.on("join", ({ code: c, name, playerId }, cb) => {
    const r = rooms.get((c || "").toUpperCase());
    if (!r) return cb({ error: "That room doesn't exist. Check the link." });
    // rejoin
    const existing = r.players.find((p) => p.id === playerId);
    if (existing) {
      room = r; me = existing; me.socket = socket;
      cb({ code: r.code, playerId: me.id });
      return broadcast(r);
    }
    if (r.players.length >= 2) return cb({ error: "That room already has two players." });
    if (r.phase !== "lobby") return cb({ error: "That draft has already started." });
    room = r;
    me = { id: randomBytes(8).toString("hex"), name: clean(name), money: START_MONEY, team: [], socket };
    r.players.push(me);
    cb({ code: r.code, playerId: me.id });
    say(r, `${me.name} joined.`);
    broadcast(r);
  });

  socket.on("start", () => {
    if (!room || room.phase !== "lobby" || room.players.length !== 2) return;
    startGame(room);
  });

  socket.on("bid", (amount) => {
    if (!room || room.phase !== "bidding" || room.bids[me.id] !== undefined) return;
    if (!validBid(me, amount)) return socket.emit("error_msg", "Bid must be in 50p steps and within your money.");
    room.bids[me.id] = amount;
    if (Object.keys(room.bids).length === 2) resolveBids(room);
    else broadcast(room);
  });

  socket.on("guess", (n) => {
    if (!room || room.phase !== "tiebreak" || room.tiebreak.guesses[me.id] !== undefined) return;
    const [lo, hi] = room.tiebreak.range;
    if (!Number.isInteger(n) || n < lo || n > hi)
      return socket.emit("error_msg", `Guess a whole number from ${lo} to ${hi}.`);
    room.tiebreak.guesses[me.id] = n;
    if (Object.keys(room.tiebreak.guesses).length === 2) resolveTiebreak(room);
    else broadcast(room);
  });

  socket.on("next", () => {
    if (!room || room.phase !== "reveal") return;
    nextRound(room);
  });

  socket.on("disconnect", () => {
    if (me) me.socket = null;
    if (room) broadcast(room);
  });
});

function clean(name) {
  return String(name || "Trainer").trim().slice(0, 16) || "Trainer";
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`PokéDraft on http://localhost:${PORT}`));
