// Battle engine: level-50 stats, real type chart, one STAB move per type (+ optional TM move), auto-resolved.
export const TYPES = ["normal","fire","water","grass","electric","ice","fighting","poison","ground","flying",
  "psychic","bug","rock","ghost","dragon","dark","steel","fairy"];

// attacker type -> { defender type: multiplier } (only non-1 entries)
const CHART = {
  normal:   { rock:.5, ghost:0, steel:.5 },
  fire:     { fire:.5, water:.5, grass:2, ice:2, bug:2, rock:.5, dragon:.5, steel:2 },
  water:    { fire:2, water:.5, grass:.5, ground:2, rock:2, dragon:.5 },
  grass:    { fire:.5, water:2, grass:.5, poison:.5, ground:2, flying:.5, bug:.5, rock:2, dragon:.5, steel:.5 },
  electric: { water:2, grass:.5, electric:.5, ground:0, flying:2, dragon:.5 },
  ice:      { fire:.5, water:.5, grass:2, ice:.5, ground:2, flying:2, dragon:2, steel:.5 },
  fighting: { normal:2, ice:2, poison:.5, flying:.5, psychic:.5, bug:.5, rock:2, ghost:0, dark:2, steel:2, fairy:.5 },
  poison:   { grass:2, poison:.5, ground:.5, rock:.5, ghost:.5, steel:0, fairy:2 },
  ground:   { fire:2, grass:.5, electric:2, poison:2, flying:0, bug:.5, rock:2, steel:2 },
  flying:   { grass:2, electric:.5, fighting:2, bug:2, rock:.5, steel:.5 },
  psychic:  { fighting:2, poison:2, psychic:.5, dark:0, steel:.5 },
  bug:      { fire:.5, grass:2, fighting:.5, poison:.5, flying:.5, psychic:2, ghost:.5, dark:2, steel:.5, fairy:.5 },
  rock:     { fire:2, ice:2, fighting:.5, ground:.5, flying:2, bug:2, steel:.5 },
  ghost:    { normal:0, psychic:2, ghost:2, dark:.5 },
  dragon:   { dragon:2, steel:.5, fairy:0 },
  dark:     { fighting:.5, psychic:2, ghost:2, dark:.5, fairy:.5 },
  steel:    { fire:.5, water:.5, electric:.5, ice:2, rock:2, steel:.5, fairy:2 },
  fairy:    { fire:.5, fighting:2, poison:.5, dragon:2, dark:2, steel:.5 },
};
const SPECIAL = new Set(["fire","water","grass","electric","ice","psychic","dragon","dark"]);
const MOVE_NAME = { normal:"Body Slam", fire:"Flamethrower", water:"Surf", grass:"Energy Ball", electric:"Thunderbolt",
  ice:"Ice Beam", fighting:"Close Combat", poison:"Sludge Bomb", ground:"Earthquake", flying:"Brave Bird",
  psychic:"Psychic", bug:"X-Scissor", rock:"Stone Edge", ghost:"Shadow Ball", dragon:"Dragon Pulse",
  dark:"Crunch", steel:"Iron Head", fairy:"Moonblast" };
const LEVEL = 50, DEFAULT_POWER = 90;

export function effectiveness(moveType, defenderTypes) {
  return defenderTypes.reduce((m, t) => m * (CHART[moveType]?.[t] ?? 1), 1);
}
const stat = (base) => Math.floor(((2 * base + 31) * LEVEL) / 100) + 5;
const hpStat = (base) => Math.floor(((2 * base + 31) * LEVEL) / 100) + LEVEL + 10;

function fighter(mon, side, slot) {
  const moves = [...new Set([...mon.types, mon.tm].filter(Boolean))].map((t) => ({ type: t, name: MOVE_NAME[t], stab: mon.types.includes(t) }));
  return { side, slot, id: mon.id, name: mon.name, sprite: mon.sprite, types: mon.types, power: mon.power || DEFAULT_POWER,
    maxHp: hpStat(mon.stats.hp), hp: hpStat(mon.stats.hp),
    atk: stat(mon.stats.attack), def: stat(mon.stats.defense),
    spa: stat(mon.stats["special-attack"]), spd: stat(mon.stats["special-defense"]),
    spe: stat(mon.stats.speed), moves };
}

function damage(att, def, move, roll) {
  const eff = effectiveness(move.type, def.types);
  if (eff === 0) return { dmg: 0, eff };
  const special = SPECIAL.has(move.type);
  const a = special ? att.spa : att.atk, d = special ? def.spd : def.def;
  let dmg = Math.floor(Math.floor(Math.floor((2 * LEVEL) / 5 + 2) * att.power * a / d) / 50) + 2;
  dmg = Math.floor(dmg * (move.stab ? 1.5 : 1) * eff * roll);
  return { dmg: Math.max(1, dmg), eff };
}

// picks the move with the highest expected damage (deterministic roll for the comparison)
function bestMove(att, def) {
  return att.moves.map((m) => ({ m, ...damage(att, def, m, 0.925) })).sort((x, y) => y.dmg - x.dmg)[0].m;
}

export function simulate(teams, rng = Math.random) {
  // teams: [{ playerId, mons:[...ordered] }, { ... }]
  const lines = teams.map((t, side) => t.mons.map((m, i) => fighter(m, side, i)));
  const active = [lines[0][0], lines[1][0]];
  const events = [];
  const send = (side) => { events.push({ t: "send", side, mon: pub(active[side]) }); };
  send(0); send(1);
  let turn = 0;
  while (turn++ < 500) {
    const [a, b] = active;
    const order = a.spe === b.spe ? (rng() < 0.5 ? [a, b] : [b, a]) : (a.spe > b.spe ? [a, b] : [b, a]);
    let fainted = false;
    for (const att of order) {
      const def = active[1 - att.side];
      if (att.hp <= 0) continue;
      const move = bestMove(att, def);
      const { dmg, eff } = damage(att, def, move, 0.85 + rng() * 0.15);
      def.hp = Math.max(0, def.hp - dmg);
      events.push({ t: "hit", side: att.side, move: move.name, type: move.type, eff, dmg, hp: def.hp, maxHp: def.maxHp });
      if (def.hp === 0) {
        events.push({ t: "faint", side: def.side, mon: pub(def) });
        const next = lines[def.side].find((f) => f.hp > 0);
        if (!next) { events.push({ t: "end", winnerSide: att.side }); return { events, winnerId: teams[att.side].playerId }; }
        active[def.side] = next; send(def.side); fainted = true; break;
      }
    }
  }
  events.push({ t: "end", winnerSide: null });
  return { events, winnerId: null };
}
const pub = (f) => ({ name: f.name, sprite: f.sprite, types: f.types, hp: f.hp, maxHp: f.maxHp, moves: f.moves.map((m) => m.name) });
