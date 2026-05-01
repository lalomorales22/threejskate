# tasks.md — 5-phase rebuild plan

Goal: turn the current single-player Three.js skate prototype into a **multiplayer, round-based, leaderboard-driven, map-editable, character-customizable jam game** using the Kenney *Mini Skate* asset pack — in time for the hackathon.

Each phase is shippable on its own. You can playtest at the end of every phase.

---

## Phase 1 — Kenney asset swap + visual glow-up

**Goal:** replace the old OBJ/FBX placeholders with the Mini Skate GLB set. Park still single-player, but it looks like the shipped game.

- [ ] Add a `GLTFLoader` asset manager in `js/Assets.js` that preloads all 20 Kenney GLBs once and hands out cached clones.
- [ ] Map each existing park cell type in `js/Park.js` to a Kenney model:
  - flat floor → `floor-concrete.glb` / `floor-wood.glb`
  - low rail → `rail-low.glb`, high rail → `rail-high.glb`, curved → `rail-curve.glb`, sloped → `rail-slope.glb`
  - quarter/half pipe → `half-pipe.glb`
  - bowl pieces → `bowl-corner-inner/outer.glb`, `bowl-side.glb`
  - stair set → `steps.glb`
  - boxes → `obstacle-box.glb`, `obstacle-middle.glb`, `obstacle-end.glb`
  - platforms → `structure-platform.glb`, `structure-wood.glb`
  - pallet → `pallet.glb`
- [ ] Update physics colliders in `js/Physics.js` to match the new model bounding volumes (AABBs from the GLB scenes).
- [ ] Swap the board for `skateboard.glb` (parent under the existing procedural rider so trick rotations still drive it).
- [ ] Stop loading `objects/*.obj` at runtime (keep folder on disk for reference), point everything at `mini-skate/Models/GLB format/`.
- [ ] Tweak bloom / fog / sun color for the new Kenney palette (matcap-y, flat-shaded).
- [ ] **Deferred to Phase 4**: swap the rider for `character-skate-boy.glb` / `character-skate-girl.glb`. The current procedural rider drives every trick pose (arm grabs, leg tuck, board-under-feet grind tilt). Re-authoring those against a rigged GLB is a fresh animation pass and pairs naturally with the customizer work in Phase 4.

**Done when:** single-player runs with Kenney visuals, character has at least 5 animation states wired, no OBJ files loaded at runtime.

---

## Phase 2 — Server, multiplayer presence, and the .env

**Goal:** second tab joins first tab. You see each other skate in real time. No rounds yet.

- [ ] `npm init`, add `express`, `ws`, `better-sqlite3`, `dotenv`, `nodemon` (dev).
- [ ] Create `server/index.js`: Express serves the static client; `ws` runs on the same port at `/ws`.
- [ ] `.env.example` with `PORT`, `SESSION_SECRET`, `TRICK_HMAC_SECRET`, `ROUND_*`, `DB_PATH`. Add `.env` to `.gitignore`.
- [ ] Protocol v1 (JSON messages):
  - `hello { name, loadout }` → server assigns `playerId`, broadcasts `join`.
  - `state { pos, quat, vel, tricking }` @ 15 Hz from client.
  - `trick { name, score, combo }` on commit.
  - `leave` on disconnect.
  - Server fan-out: `peers` (full list on join), `peer_state`, `peer_trick`, `peer_left`.
- [ ] Client `js/Net.js` — tiny WebSocket wrapper with reconnect + exponential backoff.
- [ ] Client `js/RemoteSkater.js` — interpolated ghost skater. One-way (no physics sim), just smoothed transform + animation clip driven by incoming state. Shows a floating name tag.
- [ ] Throttle + quantize outgoing state (positions to cm, quats to 16-bit, only send when changed).
- [ ] Add a tiny player-count HUD chip so you can see presence working.

**Done when:** open two tabs → you see the other skater moving in real time, their tricks pop above their head.

---

## Phase 3 — Rounds, timer, leaderboard, SQLite

**Goal:** the actual game — 2-minute rounds, winner enters name, name persists forever.

- [ ] `server/db.js` + `server/schema.sql`:
  - `maps (id, seed, cells_blob, name, created_by, created_at)`
  - `rounds (id, map_id, started_at, ended_at, winner_player_id, winner_name, winner_score)`
  - `scores (id, round_id, player_id, display_name, score, tricks_json)`
  - `players (id, display_name, total_rounds, best_score, created_at)` — anonymous, keyed by a cookie token.
- [ ] `server/round.js` — state machine (`WARMUP → COUNTDOWN → ROUND → NAME_ENTRY → COOLDOWN → WARMUP`).
  - `setInterval` ticks every 250 ms, broadcasts `round_state { phase, remainingMs, mapId, scores }`.
  - Start trigger: 5-min interval **or** `players ≥ MIN_PLAYERS_FOR_INSTANT_START`, whichever first.
- [ ] Client `js/Leaderboard.js`:
  - Live round-score list (sorted desc, updates per `peer_trick`).
  - All-time top 10 overlay (fetched from `GET /api/leaderboard`).
  - Tab to toggle; always visible in `NAME_ENTRY` phase.
- [ ] `NAME_ENTRY`: winner client gets a modal, types 3–12 chars, submits. Server writes to `rounds` + `scores` + updates `players.best_score`. Broadcasts `round_winner`.
- [ ] Anti-cheat lite: server caps score/sec and airtime; rejects `trick` messages exceeding threshold. HMAC the trick payload with `TRICK_HMAC_SECRET`.
- [ ] `REST: GET /api/leaderboard?limit=50`, `GET /api/map/:id`.

**Done when:** two tabs, warmup → 2-min round → winner types name → leaderboard updates → cooldown → next round starts. Restart the server; leaderboard survives.

---

## Phase 4 — Character customizer + randomize button

**Goal:** every skater looks different. The randomize button is the star of the demo.

- [ ] `js/Customizer.js` — modal opened with `E` during warmup.
  - **Rig**: boy / girl (swap GLB, re-target animation clips by bone name).
  - **Deck**: 8 preset textures (apply to the skateboard mesh). Base via Kenney `colormap.png` tinting; add a few hand-drawn variants.
  - **Wheels**: 6 colors.
  - **Hat**: none, beanie, helmet, cap (small extra GLBs parented to the head bone — make simple primitives if time is tight).
  - **Shirt color**: HSL tint of the torso submesh.
  - **Trail FX**: off, sparkles, fire, rainbow (reuse `Particles.js`, add emitters).
- [ ] `🎲 RANDOMIZE` button — rolls every slot with weighted randomness (rarer items like rainbow trail show up ~5% of the time, for dopamine).
- [ ] Persist loadout to `localStorage`; send in `hello` so peers see it.
- [ ] `RemoteSkater` renders peers with their loadout (same apply function, just on the remote rig).
- [ ] Tiny nameplate above each remote skater shows their display name.

**Done when:** you can fully customize, randomize, and everyone else sees your look update live.

---

## Phase 5 — Random maps + user-built map editor

**Goal:** every round has a fresh park. Players can build their own and play them.

- [ ] `server/mapgen.js` — seeded procedural park:
  - Grid of N×N cells (default 16×16).
  - Weighted-random fill from a piece palette (rails/bowls/ramps/steps/boxes) with adjacency rules (ramps face open floor, rails don't overlap).
  - Guaranteed spawn area (3×3 flat at center).
  - Returns cell blob compatible with `js/Park.js`'s `decodeCells()`.
  - Server picks a fresh seed for each round, persists map, broadcasts `mapId`.
- [ ] Client `js/Editor.js` — in-browser editor opened with `M` during warmup:
  - Top-down 2D grid view + live 3D preview.
  - Palette sidebar with the Kenney pieces; click-to-paint, right-click to erase, rotate with `R`.
  - Spawn marker, bounds editor.
  - **Save**: `POST /api/map` with cells + name. Server stores; returns a short shareable code (e.g., `/?m=a7bXk`).
  - **Play**: client loads map locally, or hosts a private lobby using that map.
- [ ] Hook `?m=<code>` in `index.html` → fetch map → bypass `DEFAULT_PARK`. (Existing `?map=` URL param already handles the cell blob; extend to resolve short codes.)
- [ ] "Map of the round" overlay during `COUNTDOWN` shows name + author.
- [ ] Optional stretch: community vote during `COOLDOWN` — next round picks from top-voted user maps.

**Done when:** editor ships, a user-built map can be played by a full lobby, and random maps rotate every round.

---

## Stretch goals (post-jam, if time allows)

- Replay mode: record winner's round as position/trick timeline, play back during `NAME_ENTRY`.
- Spectator camera for queued players.
- Daily challenge map pinned for 24 hours.
- Mobile touch controls.
- Sound pack per character.

---

## Hackathon demo script (90 seconds)

1. Show the landing page — skater auto-joins warmup with 2 others already there.
2. Hit `E` → randomize button → character changes mid-slide. Crowd-pleaser.
3. Round starts. Land a 360 Flip into a rail grind. Score popup.
4. Buzzer → win → type name. Leaderboard updates live in everyone's tab.
5. Cooldown → new random park loads. Open `M`, build a 5-piece park in 20 seconds, save, hand the URL to the judge.
6. Mic drop.
