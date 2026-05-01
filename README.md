# threejskate — Mini Skate Jam

A browser-based **multiplayer skateboarding game** built with Three.js, the Kenney *Mini Skate* asset pack, and a Node/WebSocket backend. Players join a shared lobby, 2-minute rounds start on a schedule (every 5 min, or as soon as 10 skaters are in), and the top scorer at the buzzer gets their name immortalized on the leaderboard.

Built for a game-jam hackathon. Fast to load, fun to watch, easy to lose an afternoon to.

<img width="1254" height="1254" alt="skate" src="https://github.com/user-attachments/assets/c076e193-0c8f-4dcb-ab1b-e078a90cbab2" />


---

## Core loop

1. **Join** — open the site, pick/randomize a skater, land in the current lobby.
2. **Warm up** — roll around a randomly selected (or user-built) park with everyone else.
3. **Round begins** — every 5 minutes on the clock, or instantly when 10 players are in.
4. **Two minutes** — chain tricks, grind rails, eat pavement. Every trick is broadcast live.
5. **Buzzer** — top scorer enters a 3-letter name. Leaderboard updates for everyone. 15-second cooldown, next park loads, loop repeats.

---

## Features

### Gameplay (already built, will be polished)
- Full trick vocabulary — ollie / flip / grab / grind, each × 9 directional variants (see `js/Skater.js`, `TRICK_CATALOG`).
- Combo scoring with trick pop-ups and combo multipliers.
- Physics via **crashcat** (Jolt-wasm binding). Contact-based grounded tracking, rail snapping for grinds.
- Kenney *Mini Skate* CC0 assets (20 models, 58 animations across the two rigged characters).

### New (this rebuild)
- **Multiplayer** — WebSocket-synced skater positions, rotations, and trick events. Everyone sees everyone.
- **Scheduled rounds** — server-authoritative 2-minute timer. Starts every 5 min or at 10-player threshold, whichever comes first.
- **Persistent leaderboard** — SQLite-backed, per-map and all-time. Winner of each round types in their name.
- **Randomized parks** — server rolls a fresh seed each round; park is built from Kenney primitives (rails, bowls, ramps, steps, pallets, platforms).
- **Map editor** — in-browser grid editor. Build a park, save it, share its code, play it with friends.
- **Character customizer** — swap skater model (boy/girl rig), board deck, wheel color, hat, shirt, trail FX. **Randomize button** rolls a full loadout. Saved to localStorage and sent to peers.

---

## Tech stack

| Layer       | Tool                                                                 |
| ----------- | -------------------------------------------------------------------- |
| Rendering   | [Three.js](https://threejs.org/) 0.184, UnrealBloom, light probes    |
| Physics     | [crashcat](https://www.npmjs.com/package/crashcat) (Jolt wasm)       |
| Assets      | [Kenney Mini Skate](https://kenney.nl/assets/mini-skate) (CC0)       |
| Backend     | Node + [ws](https://github.com/websockets/ws) (WebSocket)            |
| Persistence | SQLite via `better-sqlite3`                                          |
| Serving     | Express (static + REST for leaderboard reads)                        |
| Secrets     | `.env` via `dotenv`                                                  |

---

## Repo layout

```
threejskate/
├── index.html              # client entry — importmap pulls three@0.184 + crashcat from CDN
├── js/                     # Three.js client
│   ├── main.js             # boot, render loop, round state
│   ├── Skater.js           # trick catalog, combo logic, procedural rider
│   ├── Park.js             # Kenney prefabs + park builder
│   ├── Physics.js          # crashcat world + colliders, rail snapping, grind detection
│   ├── ObjColliders.js     # OBJ-derived collision meshes
│   ├── Controls.js         # keyboard + gamepad + touch
│   ├── Camera.js
│   ├── Particles.js        # GrindSparks + TrailFX
│   ├── Assets.js           # cached GLTFLoader
│   ├── Loadout.js          # SWATCHES, HATS, TRAILS, randomLoadout()
│   ├── Customizer.js       # F1 character/board loadout UI
│   ├── Editor.js           # M map editor modal (top-down 2D)
│   ├── Leaderboard.js      # round banner + scoreboard + name-entry modal
│   ├── Net.js              # WebSocket client, 15 Hz state throttle
│   └── RemoteSkater.js     # ghost renderer for peers
├── server/
│   ├── index.js            # Express static + /ws WebSocket + REST endpoints
│   ├── round.js            # round scheduler / state machine
│   ├── db.js               # better-sqlite3 wrappers, transaction-safe saveRound
│   ├── mapgen.js           # seeded mulberry32 random park generator
│   └── schema.sql          # players, rounds, scores, maps
├── mini-skate/             # Kenney asset pack (GLB + OBJ + textures, CC0)
├── data/                   # SQLite file lives here (gitignored)
├── .env.example
├── tasks.md                # 5-phase build plan (all phases shipped)
├── handoff.md              # design + decision log
└── README.md
```

---

## Round state machine (server-authoritative)

```
  WARMUP ──(T=5min elapsed OR players≥10)──▶ COUNTDOWN(5s)
     ▲                                             │
     │                                             ▼
  COOLDOWN(15s) ◀──(name entered OR timeout)── NAME_ENTRY ◀─ ROUND(120s)
```

Every state transition is broadcast to all clients. Clients never decide round state themselves — they just render what the server tells them. Trick events are sent client→server with HMAC-signed payloads (secret in `.env`) so hot-path score math stays client-side but the server can reject anything implausible (score/sec caps, airtime sanity).

---

## Running it

Requires Node.js 18+ (for `node --watch` and built-in fetch).

```bash
git clone https://github.com/lalomorales22/threejskate.git
cd threejskate
cp .env.example .env        # tweak PORT or secrets if you want
npm install                 # builds better-sqlite3 native bindings
npm run dev                 # starts server on :3000 with auto-reload
```

The SQLite database at `data/skate.db` is created on first run — no separate init step.

Open `http://localhost:3000`. For multiplayer testing, open a few tabs.

For production-style serving without the file watcher:

```bash
npm start
```

---

## Environment (`.env`)

```
PORT=3000
SESSION_SECRET=change-me
TRICK_HMAC_SECRET=change-me-too
ROUND_INTERVAL_MS=300000
ROUND_DURATION_MS=120000
MIN_PLAYERS_FOR_INSTANT_START=10
DB_PATH=./data/skate.db
```

---

## Controls

| Key          | Action                                           |
| ------------ | ------------------------------------------------ |
| WASD         | Steer / push                                     |
| SPACE (hold) | Charge ollie; release to pop                     |
| J            | Flip (pairs with WASD for variants)              |
| K            | Grab (hold)                                      |
| L            | Grind (requires rail contact)                    |
| Tab          | Toggle leaderboard                               |
| E            | Open customizer (warmup only)                    |
| M            | Open map editor (warmup only)                    |

---

## Credits

- **Assets**: [Kenney — Mini Skate](https://kenney.nl/assets/mini-skate) (CC0 1.0 Universal). Bundled in [`mini-skate/`](mini-skate/) under their original CC0 license — see `mini-skate/License.txt`.
- **Physics**: [crashcat](https://www.npmjs.com/package/crashcat) — Jolt Physics wasm wrapper.
- **Rendering**: [Three.js](https://threejs.org/) (MIT).
- **Everything else**: built for the jam.

## License

Source code is released under the [MIT License](LICENSE). Bundled Kenney assets under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
