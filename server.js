import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { randomBytes } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { simulate, TYPES } from "./battle.js";
const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const http = createServer(app);
const io = new Server(http);
app.get("/", (_req, res) => res.sendFile(join(__dirname, "index.html")));

// ---------- config ----------
const START_MONEY = 20;
const BID_STEP = 0.5;
const TEAM_SIZE = 6;
const POOL_SIZE = TEAM_SIZE * 2;
const EXACT_GUESS_BONUS = 1;
const UPGRADES = ["swap", "evolve", "tm"]; // post-draft auctions, in order
const LINEUP_SECONDS = 60;
const POWER_TIERS = [60, 75, 90];
const LUCKY_CHANCE = 0.2;      // chance a drafted/mystery Pokémon rolls one power tier up
const FULL_EVOLVE_CHANCE = 0.2; // chance the evolve auction is "evolve to final form"

const GENS = {
  all: [1, 1025],
  1: [1, 151], 2: [152, 251], 3: [252, 386], 4: [387, 493],
  5: [494, 649], 6: [650, 721], 7: [722, 809], 8: [810, 905], 9: [906, 1025],
};

// ---------- PokéAPI ----------
const cache = new Map();
async function api(path) {
  const res = await fetch(`https://pokeapi.co/api/v2/${path}`);
  if (!res.ok) throw new Error(`PokéAPI ${path}: ${res.status}`);
  return res.json();
}
async function fetchPokemon(id) {
  if (cache.has(id)) return cache.get(id);
  const d = await api(`pokemon/${id}`);
  const p = {
    id: d.id,
    name: d.name.replace(/-/g, " "),
    sprite: d.sprites.other?.["official-artwork"]?.front_default || d.sprites.front_default,
    types: d.types.map((t) => t.type.name),
    stats: Object.fromEntries(d.stats.map((s) => [s.stat.name, s.base_stat])),
  };
  cache.set(id, p);
  return p;
}
const idFromUrl = (u) => +u.split("/").filter(Boolean).pop();
const lineCache = new Map();
// evolution line info for a species: stage (1-based), stages in its line, next stages, final forms
async function fetchLine(id) {
  if (lineCache.has(id)) return lineCache.get(id);
  let line = { stage: 1, stages: 1, evolvesTo: [], finals: [] };
  try {
    const species = await api(`pokemon-species/${id}`);
    const chain = await api(species.evolution_chain.url.replace(/.*\/api\/v2\//, ""));
    const sp = (n) => ({ id: idFromUrl(n.species.url), name: n.species.name });
    const depthBelow = (n) => n.evolves_to.length ? 1 + Math.max(...n.evolves_to.map(depthBelow)) : 0;
    const leaves = (n) => n.evolves_to.length ? n.evolves_to.flatMap(leaves) : [sp(n)];
    const find = (n, d) => {
      if (idFromUrl(n.species.url) === id) return [n, d];
      for (const c of n.evolves_to) { const r = find(c, d + 1); if (r) return r; }
      return null;
    };
    const hit = find(chain.chain, 0);
    if (hit) {
      const [node, depth] = hit;
      line = { stage: depth + 1, stages: depth + 1 + depthBelow(node),
        evolvesTo: node.evolves_to.map(sp).filter((e) => e.id <= GENS.all[1]),
        finals: leaves(node).filter((e) => e.id <= GENS.all[1] && e.id !== id) };
    }
  } catch {}
  lineCache.set(id, line);
  return line;
}
const bst = (m) => Object.values(m.stats).reduce((a, b) => a + b, 0);
function baseTier(mon, line) {
  if (line.stages === 1) return bst(mon) >= 580 ? 2 : bst(mon) >= 450 ? 1 : 0;
  if (line.stages === 2) return line.stage === 1 ? 0 : 2;
  return Math.min(line.stage - 1, 2);
}
// attaches stage/stages/power/lucky to a (cloned) Pokémon
async function prepare(mon, { roll = true, lucky = false } = {}) {
  const line = await fetchLine(mon.id);
  const isLucky = lucky || (roll && Math.random() < LUCKY_CHANCE);
  const tier = Math.min(baseTier(mon, line) + (isLucky ? 1 : 0), POWER_TIERS.length - 1);
  return { ...clone(mon), stage: line.stage, stages: line.stages, power: POWER_TIERS[tier], lucky: isLucky };
}
function randomId(gen) {
  const [lo, hi] = GENS[gen] || GENS.all;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}
function randomIds(gen, n) {
  const ids = new Set();
  while (ids.size < n) ids.add(randomId(gen));
  return [...ids];
}
const clone = (m) => JSON.parse(JSON.stringify(m));

// ---------- rooms ----------
const rooms = new Map();
const code = () => randomBytes(3).toString("hex").toUpperCase();

function newRoom(gen) {
  const room = {
    code: code(),
    gen: GENS[gen] ? gen : "all",
    stage: "draft", // draft | upgrade | battle
    phase: "lobby", // lobby | loading | bidding | tiebreak | reveal | choose | lineup | result
    lineups: {}, // playerId -> [slot indexes]
    lineupDeadline: null,
    battle: null, // { events, winnerId }
    players: [],
    pool: [],
    round: 0,
    bids: {},
    reveal: null,
    tiebreak: null,
    upgrade: null, // { index, kind, mystery, winnerId, price }
    log: [],
  };
  rooms.set(room.code, room);
  return room;
}

function currentLot(room) {
  if (room.stage === "draft") return room.pool[room.round];
  if (room.stage === "upgrade") {
    const u = room.upgrade;
    if (u.kind === "swap") return { kind: "swap", mystery: { types: u.mystery.types, sprite: u.mystery.sprite, power: u.mystery.power, lucky: u.mystery.lucky } };
    return { kind: u.kind, full: !!u.full };
  }
  return null;
}

function publicState(room, viewerId) {
  const u = room.upgrade;
  return {
    code: room.code,
    gen: room.gen,
    stage: room.stage,
    phase: room.phase,
    round: room.round,
    poolSize: room.pool.length,
    lot: ["bidding", "tiebreak"].includes(room.phase) ? currentLot(room) : null,
    upgrade: u ? { index: u.index, kind: u.kind, full: !!u.full, total: UPGRADES.length, winnerId: u.winnerId,
      mystery: room.phase === "choose" && u.kind === "swap" ? { types: u.mystery.types, sprite: u.mystery.sprite } : null } : null,
    players: room.players.map((p) => ({
      id: p.id, name: p.name, money: p.money,
      team: p.team.map((m) => ({ ...m, evolvesTo: lineCache.get(m.id)?.evolvesTo || [], finals: lineCache.get(m.id)?.finals || [] })),
      connected: !!p.socket,
      hasBid: room.bids[p.id] !== undefined,
      hasGuessed: room.tiebreak?.guesses[p.id] !== undefined,
      you: p.id === viewerId,
    })),
    tiebreak: room.tiebreak ? { range: room.tiebreak.range, sprite: room.tiebreak.sprite } : null,
    reveal: room.reveal,
    lineupDeadline: room.lineupDeadline,
    lineupsIn: Object.keys(room.lineups),
    battle: room.battle,
    types: TYPES,
    log: room.log.slice(-14),
  };
}
function broadcast(room) {
  for (const p of room.players) if (p.socket) p.socket.emit("state", publicState(room, p.id));
}
const say = (room, text) => room.log.push(text);

// ---------- draft ----------
async function startGame(room) {
  room.phase = "loading";
  broadcast(room);
  try {
    room.pool = await Promise.all(randomIds(room.gen, POOL_SIZE).map(async (id) => prepare(await fetchPokemon(id))));
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
  room.reveal = { lot: currentLot(room), bids: { [a.id]: ba, [b.id]: bb }, winnerId: null, reason: null };
  if (ba !== bb) return finishAuction(room, ba > bb ? a : b, Math.max(ba, bb), "outbid");
  startTiebreak(room, ba);
}

async function startTiebreak(room, amount) {
  const [lo, hi] = GENS.all;
  let hidden;
  try { hidden = await fetchPokemon(randomId("all")); } catch { hidden = { id: randomId("all"), sprite: null }; }
  room.tiebreak = { target: hidden.id, sprite: hidden.sprite, range: [lo, hi], guesses: {} };
  room.phase = "tiebreak";
  say(room, `Both bid £${amount.toFixed(2)}. Tiebreak: name that Pokémon's number.`);
  broadcast(room);
}

function resolveTiebreak(room) {
  const [a, b] = room.players;
  const t = room.tiebreak;
  const ga = t.guesses[a.id], gb = t.guesses[b.id];
  const da = Math.abs(ga - t.target), db = Math.abs(gb - t.target);
  const price = room.bids[a.id];
  let winner, reason;
  if (da !== db) { winner = da < db ? a : b; reason = "closer guess"; }
  else { winner = Math.random() < 0.5 ? a : b; reason = "coin flip"; }
  room.reveal.tiebreak = { target: t.target, sprite: t.sprite, guesses: { [a.id]: ga, [b.id]: gb }, reason };
  for (const p of [a, b]) if (t.guesses[p.id] === t.target) {
    p.money += EXACT_GUESS_BONUS;
    say(room, `${p.name} guessed #${t.target} exactly — +£${EXACT_GUESS_BONUS}.`);
  }
  room.tiebreak = null;
  finishAuction(room, winner, price, reason);
}

function finishAuction(room, winner, price, reason) {
  winner.money = +(winner.money - price).toFixed(2);
  room.reveal.winnerId = winner.id;
  room.reveal.reason = reason;
  room.bids = {};
  if (room.stage === "draft") {
    const mon = room.pool[room.round];
    winner.team.push(clone(mon));
    say(room, `${winner.name} wins ${mon.name} for £${price.toFixed(2)} (${reason}).`);
    room.phase = "reveal";
    const full = room.players.find((p) => p.team.length >= TEAM_SIZE);
    if (full) {
      const other = room.players.find((p) => p !== full);
      const leftovers = room.pool.slice(room.round + 1);
      other.team.push(...leftovers.map(clone));
      if (leftovers.length)
        say(room, `${full.name} has a full team. ${other.name} gets ${leftovers.map((m) => m.name).join(", ")} for free.`);
      room.round = room.pool.length; // draft over; next "next" moves to upgrades
    }
  } else {
    const u = room.upgrade;
    u.winnerId = winner.id; u.price = price;
    say(room, `${winner.name} wins the ${u.kind} for £${price.toFixed(2)} (${reason}).`);
    room.phase = "reveal";
  }
  broadcast(room);
}

function nextStep(room) {
  room.reveal = null;
  if (room.stage === "draft") {
    room.round += 1;
    if (room.round >= room.pool.length) return startUpgrades(room);
    room.phase = "bidding";
    return broadcast(room);
  }
  if (room.stage === "upgrade") {
    if (room.upgrade.winnerId) { room.phase = "choose"; return broadcast(room); }
    return startUpgrade(room, room.upgrade.index + 1);
  }
}

// ---------- upgrades ----------
async function startUpgrades(room) {
  room.stage = "upgrade";
  room.phase = "loading";
  say(room, "Draft complete. Three upgrade auctions: swap, evolve, TM.");
  broadcast(room);
  for (const p of room.players) for (const m of p.team) await fetchLine(m.id);
  startUpgrade(room, 0);
}

async function startUpgrade(room, index) {
  if (index >= UPGRADES.length) return startLineup(room);
  const kind = UPGRADES[index];
  room.upgrade = { index, kind, mystery: null, winnerId: null, price: 0, full: kind === "evolve" && Math.random() < FULL_EVOLVE_CHANCE };
  if (kind === "swap") {
    room.phase = "loading"; broadcast(room);
    try { room.upgrade.mystery = await prepare(await fetchPokemon(randomId(room.gen))); }
    catch { return startUpgrade(room, index + 1); }
  }
  room.phase = "bidding";
  say(room, { swap: "Swap auction: replace one of yours with the mystery Pokémon.",
    evolve: room.upgrade.full ? "Rare find! This evolve auction takes a Pokémon straight to its final form." : "Evolve auction: evolve one of your Pokémon a stage.",
    tm: "TM auction: teach one of your Pokémon a second move type." }[kind]);
  broadcast(room);
}

async function applyChoice(room, player, choice) {
  const u = room.upgrade;
  if (!u || u.winnerId !== player.id || room.phase !== "choose") return "Not your choice to make.";
  const slot = player.team[choice.slot];
  if (!slot) return "Pick a Pokémon from your team.";
  if (u.kind === "swap") {
    player.team[choice.slot] = clone(u.mystery);
    say(room, `${player.name} swapped ${slot.name} for ${u.mystery.name}.`);
  } else if (u.kind === "evolve") {
    const line = lineCache.get(slot.id) || { evolvesTo: [], finals: [] };
    const opts = u.full ? line.finals : line.evolvesTo;
    const target = opts.find((o) => o.id === choice.targetId) || (opts.length === 1 ? opts[0] : null);
    if (!target) return opts.length ? "Choose which evolution." : "That Pokémon can't evolve — pick another.";
    let evolved;
    try { evolved = await prepare(await fetchPokemon(target.id), { roll: false, lucky: slot.lucky }); }
    catch { return "Couldn't load the evolution. Try again."; }
    player.team[choice.slot] = { ...evolved, tm: slot.tm };
    say(room, `${player.name} evolved ${slot.name} into ${evolved.name}${u.full ? " (final form)" : ""}.`);
  } else if (u.kind === "tm") {
    if (!TYPES.includes(choice.type)) return "Pick a move type.";
    slot.tm = choice.type;
    say(room, `${player.name} taught ${slot.name} a ${choice.type} move.`);
  }
  return null;
}

// ---------- battle ----------
function startLineup(room) {
  room.upgrade = null;
  room.stage = "battle";
  room.phase = "lineup";
  room.lineups = {};
  room.lineupDeadline = Date.now() + LINEUP_SECONDS * 1000;
  say(room, `Teams locked. ${LINEUP_SECONDS} seconds to set your battle order.`);
  broadcast(room);
  room.lineupTimer = setTimeout(() => {
    if (room.phase !== "lineup") return;
    for (const p of room.players) if (!room.lineups[p.id]) room.lineups[p.id] = p.team.map((_, i) => i);
    runBattle(room);
  }, LINEUP_SECONDS * 1000 + 500);
}

function validLineup(player, order) {
  if (!Array.isArray(order) || order.length !== player.team.length) return false;
  const seen = new Set(order);
  return seen.size === order.length && order.every((i) => Number.isInteger(i) && player.team[i]);
}

function runBattle(room) {
  clearTimeout(room.lineupTimer);
  const teams = room.players.map((p) => ({ playerId: p.id, mons: room.lineups[p.id].map((i) => p.team[i]) }));
  room.battle = simulate(teams);
  room.phase = "result";
  const w = room.players.find((p) => p.id === room.battle.winnerId);
  say(room, w ? `${w.name} wins the battle.` : "The battle ended in a draw.");
  broadcast(room);
}

// ---------- sockets ----------
io.on("connection", (socket) => {
  let room = null, me = null;
  const newPlayer = (name) => ({ id: randomBytes(8).toString("hex"), name: clean(name), money: START_MONEY, team: [], socket });

  socket.on("create", ({ name, gen }, cb) => {
    room = newRoom(gen);
    me = newPlayer(name);
    room.players.push(me);
    cb({ code: room.code, playerId: me.id });
    broadcast(room);
  });

  socket.on("join", ({ code: c, name, playerId }, cb) => {
    const r = rooms.get((c || "").toUpperCase());
    if (!r) return cb({ error: "That room doesn't exist. Check the link." });
    const existing = r.players.find((p) => p.id === playerId);
    if (existing) { room = r; me = existing; me.socket = socket; cb({ code: r.code, playerId: me.id }); return broadcast(r); }
    if (r.players.length >= 2) return cb({ error: "That room already has two players." });
    if (r.phase !== "lobby") return cb({ error: "That draft has already started." });
    room = r; me = newPlayer(name);
    r.players.push(me);
    cb({ code: r.code, playerId: me.id });
    say(r, `${me.name} joined.`);
    broadcast(r);
  });

  socket.on("start", () => {
    if (room && room.phase === "lobby" && room.players.length === 2) startGame(room);
  });

  socket.on("bid", (amount) => {
    if (!room || room.phase !== "bidding" || room.bids[me.id] !== undefined) return;
    if (!validBid(me, amount)) return socket.emit("error_msg", "Bid must be in 50p steps and within your money.");
    room.bids[me.id] = amount;
    if (Object.keys(room.bids).length === 2) resolveBids(room); else broadcast(room);
  });

  socket.on("guess", (n) => {
    if (!room || room.phase !== "tiebreak" || room.tiebreak.guesses[me.id] !== undefined) return;
    const [lo, hi] = room.tiebreak.range;
    if (!Number.isInteger(n) || n < lo || n > hi) return socket.emit("error_msg", `Guess a whole number from ${lo} to ${hi}.`);
    room.tiebreak.guesses[me.id] = n;
    if (Object.keys(room.tiebreak.guesses).length === 2) resolveTiebreak(room); else broadcast(room);
  });

  socket.on("next", () => {
    if (room && room.phase === "reveal") nextStep(room);
  });

  socket.on("choose", async (choice) => {
    if (!room || room.phase !== "choose") return;
    const err = await applyChoice(room, me, choice || {});
    if (err) return socket.emit("error_msg", err);
    startUpgrade(room, room.upgrade.index + 1);
  });

  socket.on("lineup", (order) => {
    if (!room || room.phase !== "lineup" || room.lineups[me.id]) return;
    if (!validLineup(me, order)) return socket.emit("error_msg", "Order must include each of your Pokémon once.");
    room.lineups[me.id] = order;
    if (Object.keys(room.lineups).length === 2) runBattle(room); else broadcast(room);
  });

  socket.on("disconnect", () => {
    if (me && me.socket === socket) me.socket = null;
    if (room) broadcast(room);
  });
});

const clean = (name) => String(name || "Trainer").trim().slice(0, 16) || "Trainer";

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`PokéDraft on http://localhost:${PORT}`));
