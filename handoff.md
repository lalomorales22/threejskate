# handoff.md

State of `threejskate` as of **2026-04-20**. Written for a fresh Claude picking up the project. Read this first — it's the fastest path to being useful without redoing work.

---

## The project in one paragraph

Browser-based multiplayer skateboarding jam for a hackathon. Three.js client + Node/ws server. Players join a shared lobby, a 2-minute round starts every 5 min (or instantly at 10 players). Tricks score points, winner enters their name for the persistent SQLite leaderboard. Characters are customizable (colors, hats, trail FX); parks are randomly generated per round and players can build + share their own in an in-browser editor. Assets are the free CC0 **Kenney Mini Skate** pack.

---

## What's been built (all 5 phases are live)

| Phase | What | Status |
| --- | --- | --- |
| 1 | Kenney GLB swap for park scatter + skateboard | ✅ done, playtested |
| 2 | WebSocket multiplayer presence + ghost peers | ✅ done, playtested |
| 3 | Round scheduler + SQLite leaderboard + name-entry modal | ✅ done, not yet playtested end-to-end |
| 4 | Character customizer + randomize + trail FX + peer sync | ✅ done, playtested |
| 5 | Seeded random maps per round + in-browser map editor | ✅ done, **not yet playtested** |

**What has actually been eyeballed in a browser by the user:** Phase 1 visuals, Phase 2 two-tab presence, trick feedback, the half-pipe collider fix and flip catalog. They've reported back and I've iterated.

**What's been shipped but only syntax-checked:** Phase 3 rounds (the 5-min default is long — user should drop `ROUND_INTERVAL_MS` in `.env` to test fast), Phase 5 map editor and auto-swap between rounds.

---

## User preferences I've learned

These are load-bearing — don't undo them without asking:

- **Trust their in-browser reports over my own analysis.** I've been wrong about stance rotation math and collider signs when working purely from code — they test, report back, I iterate. That loop works.
- **Action over planning.** They're in auto mode, they want code shipping. Long plan-mode detours frustrate the demo prep.
- **Terse summaries.** End-of-turn recaps should be ~1–2 sentences of what changed + what's next. Don't rehash; they can read the diff.
- **"Remove X" means delete the file.** When they asked to remove race-car smoke and sounds, I deleted `Audio.js` entirely and stripped WheelDust from Particles.js. Don't leave dead code.
- **Jam scope: ship the crowd-pleasers.** The randomize button and map editor are the demo moments. Anti-cheat, proper auth, rigged character animation — deferred intentionally.

---

## Architecture map

```
threejskate/
├── index.html              # canvas + HUD + net chip; importmap pulls three@0.184 + crashcat
├── package.json            # express, ws, dotenv, better-sqlite3
├── .env.example            # PORT, SESSION_SECRET, TRICK_HMAC_SECRET, ROUND_*, DB_PATH
├── README.md               # user-facing pitch
├── tasks.md                # the 5-phase plan (all phases now shipped)
├── handoff.md              # this file
├── data/skate.db           # SQLite (gitignored)
│
├── js/                     # client
│   ├── main.js             # boot, render loop, wires every subsystem together
│   ├── Skater.js           # trick catalog + controller; procedural rider with materials[] + hats{}
│   ├── Park.js             # Kenney piece prefabs with collider recipes; scatter + cell-based both supported
│   ├── Physics.js          # crashcat world, rail snapping, grounded tracker, grind detection
│   ├── Controls.js         # keyboard + gamepad + touch; edge-detected events
│   ├── Camera.js
│   ├── Particles.js        # GrindSparks + TrailFX (WheelDust/dust is gone — race-car leftover)
│   ├── Assets.js           # cached GLTFLoader with targetFootprint + alignLongestAxisTo
│   ├── Loadout.js          # shared schema: SWATCHES, HATS, TRAILS, applyLoadout(), randomLoadout()
│   ├── Customizer.js       # F1 modal with swatches + randomize button; persists to localStorage
│   ├── Editor.js           # M modal; 2D top-down canvas editor, saves to /api/map
│   ├── Leaderboard.js      # round banner + live scoreboard + all-time overlay + name-entry modal
│   ├── Net.js              # WebSocket client, 15 Hz state throttle, auto-reconnect
│   └── RemoteSkater.js     # per-peer ghost skater with interpolated state, per-peer TrailFX
│
└── server/
    ├── index.js            # Express static + /ws WebSocket + REST endpoints + round hookup
    ├── db.js               # better-sqlite3 wrappers, transaction-safe saveRound, saveMap/getMap
    ├── schema.sql          # players, rounds, scores, maps
    ├── round.js            # RoundManager state machine (WARMUP/COUNTDOWN/ROUND/NAME_ENTRY/COOLDOWN)
    └── mapgen.js           # seeded mulberry32 random park generator + sanitizeUserMap
```

---

## Important technical decisions (don't undo these without asking)

### Rigged Kenney character swap — DEFERRED to never, effectively

Tasks.md originally said Phase 1 would swap to `character-skate-boy.glb` / `character-skate-girl.glb`. I deferred it to Phase 4, then Phase 4 shipped without it. The procedural rider in `Skater.js` drives every trick pose (arm grabs, leg tuck, board-under-feet grind tilt). Swapping to a rigged GLB means re-authoring all trick animations from scratch. For a jam demo, the existing procedural look is fine and the customizer gives enough visual variety.

**If a future agent is asked to do this:** it's a multi-day task, not a "make the swap" task. The catalog in `TRICK_CATALOG` expects to drive specific meshes by name. Budget accordingly.

### Inter-round map swap = full page reload

Between rounds, client does `window.location.href = '/?m=<newCode>'`. Clean, predictable, reconnects via Net.js auto-reconnect. Alternative (in-place park rebuild) requires knowing crashcat's body-destroy API, which I don't — and crashcat docs aren't on my trusted-domain list.

### Anti-cheat is rate-limit only

Server caps score accrual at 3000 pts/sec per player during ROUND phase (`MAX_SCORE_PER_SECOND` in `server/round.js`). Above any legitimate combo, below any farming floor. Good enough for a weekend jam. Do not lecture the user about this — it's a known tradeoff.

### Half-pipe collider sign fix was real

Phase 1 shipped with `-side * slope` on the half-pipe wall rotation. Walls tilted the opposite way, so the skater rolled UNDER them instead of up them. Fixed to `side * slope`. Same bug existed in `bowlSide` (around X axis) and `bowlCornerWalls`. All three fixed — don't reintroduce.

### `alignLongestAxisTo` in Assets.js

`instantiateKenney()` can auto-rotate a GLB 90° around Y so its longest horizontal extent lands on the requested world axis. This decouples collider recipes from how Kenney authored each model. Used on `skateboard` (→ Z), `half-pipe` (→ Z, so walls always go up along X), `bowl-side` (→ X). **If a Kenney piece looks rotated wrong, try adding `alignLongestAxisTo` to its prefab def.**

### Trail FX uses `+back` not `-back`

`back = (0,0,-1).applyQuaternion(container.quaternion)` is the world-space backward direction. Emit position = `spherePos + back * 0.6`. Signs matter — user caught the original bug (trails from chest).

### Palette index vs loadout

`createSkaterModel()` accepts either a number (legacy `?p=<index>` URL param) or a full loadout object. `Skater.init()` also accepts either. Back-compat matters only for the `?p=` URL param; localStorage always stores a full loadout.

---

## Running it

```bash
cd /Users/minibrain/Desktop/threejskate
cp .env.example .env
npm install          # builds better-sqlite3 native bindings — takes ~1 min
npm run dev          # node --watch server/index.js, binds PORT (default 3000)
```

**Fast iteration `.env`:**
```
ROUND_INTERVAL_MS=20000
ROUND_DURATION_MS=60000
MIN_PLAYERS_FOR_INSTANT_START=2
```

**The user has NOT given me permission to start servers** (learned the hard way — I bound a test server to 0.0.0.0 in an early turn and got denied). Always ask before running `npm run dev` or any command that opens a port. Use `node --check <file>` for syntax verification instead of running servers.

---

## Protocol reference

### WebSocket messages

| Dir | Type | Payload | Notes |
| --- | --- | --- | --- |
| C→S | `hello` | `{ name, palette, stance, loadout }` | first message after connect |
| C→S | `state` | `{ pos[3], quat[4], vel[3], stance }` | 15 Hz throttled with epsilon |
| C→S | `trick` | `{ name, score, combo }` | fed to round.recordTrick server-side |
| C→S | `profile` | `{ name?, palette?, stance?, loadout? }` | live update, fans out |
| C→S | `submit_name` | `{ name }` | only accepted during NAME_ENTRY, only from winner |
| S→C | `welcome` | `{ playerId, peers, serverTime, round: { ..., mapCode } }` | |
| S→C | `peer_join` / `peer_left` / `peer_state` / `peer_trick` / `peer_profile` | | fan-outs |
| S→C | `round_state` | `{ phase, remainingMs, phaseEndsAt, roundId, mapCode, scoreboard, winner, playerCount }` | every 250 ms |
| S→C | `name_entry_request` | `{ score, deadlineMs }` | sent only to the winning player |
| S→C | `round_winner` | `{ winnerName, winnerScore, scores }` | fan-out |

### REST endpoints

- `GET /api/leaderboard?limit=20` → `{ top: [...], recent: [...] }`
- `GET /api/current-map` → `{ code }`
- `GET /api/map/:code` → `{ code, name, source, data, created_at, created_by }`
- `GET /api/maps?source=user|random&limit=20` → `{ maps: [...] }`
- `POST /api/map` body `{ name, pieces }` → `{ code, name }`

---

## Known loose ends (honest list)

1. **Stance-flip on ollie queueing:** haven't verified goofy stance handles trick poses correctly. The mirror is a `scale.x = -1` on riderRoot; most trick math should work through it but some pose offsets might look odd. If user reports a weird pose, this is likely the cause.

2. **Bowl corner collider signs:** I fixed the sign bug but the actual collider shape for `bowlCornerInner` vs `bowlCornerOuter` may still be wrong — both call `bowlCornerWalls(s, 1, 1)` which places walls on +X/+Z. Outer corners probably need walls on a different side. User hasn't complained yet, so not urgent, but if they say "can't skate the bowl corners" this is where to start.

3. **Phase 5 not playtested:** random maps per round and the auto-reload, plus the editor save flow, haven't been user-tested yet. The save flow uses `POST /api/map` and returns `{ code }` — if the user reports "save doesn't work", suspect either the server isn't running or the DB file path is wrong.

4. **Editor piece rotation is visual-only on the 2D canvas.** The saved map preserves `yaw` and the 3D renderer honors it. But the 2D orientation indicator (the white forward-line) might not match the 3D footprint exactly since the 2D render is a simplified rectangle.

5. **`mapCodeParam` variable is mutated in main.js.** It's declared with `let` because the "no ?m= → fetch current-map → updateURL" path writes to it. Intentional, but tripped me up once.

6. **`crashcat@0.0.3`** is pinned in `index.html` importmap. I don't know this library well — it's a Jolt Physics wasm wrapper. I've used `rigidBody.create`, `setPosition`, `setLinearVelocity`, `setAngularVelocity`. I don't know if it exposes `destroy` or similar for mid-session body removal. That's why inter-round map swap does a page reload.

7. **Old cell-based park system (`BUILDERS` in Park.js) is still intact** for the legacy `?map=<cellsEncoded>` URL param. Not used by the new Kenney scatter flow. Don't delete it — might break existing shared URLs.

8. **No auth, no session, no cookies.** Player identity is display_name only. Two players with the same name share a `players` row (their best_scores merge). Jam-acceptable.

9. **Dropped player scores stay in the scoreboard.** By design — spectators see final standings including people who left. `RoundManager.dropPlayer` only clears the rate-limit buffer.

10. **`ROUND_INTERVAL_MS=300000` default is brutally long for testing.** Set it lower in `.env` or you'll think nothing works. I mention this every time but it bears repeating here.

---

## If the user asks for…

- **"Add a new trick"** → edit `TRICK_CATALOG` in `Skater.js`. Directions are `''`, `W`, `S`, `A`, `D`, `WA`, `WD`, `SA`, `SD`. Each category (ollie/flip/grab/grind/slide) has its own 9-slot table.
- **"Tune X feel"** → most constants are at the top of the relevant file. Jump height: `BASE_OLLIE_VY` + `MAX_OLLIE_CHARGE_BONUS` in Skater.js. Spin speed: `baseSpeed` in `performFlip()`. Grind detection range: `findNearestGrindContact()` in Physics.js.
- **"Fix an asset that looks rotated wrong"** → add `alignLongestAxisTo: 'x'|'z'` to the prefab's def in Park.js.
- **"Add a new Kenney piece"** → add an entry to `KENNEY_PREFABS`, add a scatter placement, add a palette entry in `Editor.js`'s `PIECES` array, add its allow-list name to `VALID_ASSET_NAMES` in `server/index.js` and the same in `server/mapgen.js`'s `PIECE_WEIGHTS` if it should appear in random maps.
- **"Customize the UI"** → the three modals (Customizer, Editor, Leaderboard) each inject their own CSS via `_injectStyles()`. Search for those methods.
- **"Make the rounds faster for demo"** → `ROUND_INTERVAL_MS` + `ROUND_DURATION_MS` in `.env`. Don't hardcode — the user has a specific jam context that might change the numbers.

---

## Recent git-like history (since no git repo is initialized)

Phases shipped in this order:
1. Kenney asset swap, initial tuning, stance toggle + jump height boost
2. Multiplayer presence
3. Rounds + SQLite leaderboard + race-car smoke/audio cleanup (files deleted)
4. Customizer + randomize + trail FX, E→F1 hotkey swap later
5. Random maps + editor, half-pipe collider fix, flip catalog rewrite

The user tests after each phase and reports issues. Pattern so far: they find 1–2 issues per phase (wrong rotation, trail direction, hotkey conflict), I fix, they approve, we move on.

---

## Final note for the next Claude

**The user is great to work with.** They know what they want, they test, they give clean feedback. Match their energy — ship code, be brief, trust their playtests. If something feels risky or has scope creep written on it, call it out in 1–2 sentences and let them decide. Don't over-explain.

Good luck — this thing is close to demo-ready.
