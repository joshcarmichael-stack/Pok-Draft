# PokéDraft — sealed-bid Pokémon auction

## Run
    npm install
    npm start
Open http://localhost:3000 (files: server.js, index.html, package.json, render.yaml — all in one folder), pick a generation, create a room, send the link.

To share with a friend outside your network, expose port 3000 (e.g. `npx ngrok http 3000`)
or deploy to Render / Railway / Fly — it's a single Node process, no database needed.

## Rules implemented
- 2 players, £20 each, 50p increments, 6 Pokémon per team.
- 12 Pokémon are drawn at random from the chosen generation (PokéAPI).
- Each round both players submit a sealed bid; both are revealed together. Higher bid wins and pays.
- Tie: a hidden Pokémon is drawn from the same generation, both guess its Pokédex number.
  Closest wins the Pokémon. Exact guess earns a £1 bonus. Still tied → coin flip.
- When one player reaches 6, every remaining Pokémon goes to the other player for free.
- Each drawn Pokémon carries base stats and types, ready for the battle step.

## Upgrade auctions (after the draft)
- Swap: mystery Pokémon (silhouette + types shown). Winner must swap one of theirs for it.
- Evolve: winner evolves one Pokémon a stage (branching evolutions offer a choice).
- TM: winner gives one Pokémon a second move type (stored as `tm`).
- £0 bids allowed; a £0–£0 tie still goes to the tiebreak.

## Not yet built
- Battle scene (state has everything needed: `players[].team[].stats / types`).
- Random per-battle events.
