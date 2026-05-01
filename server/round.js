// Round scheduler — server-authoritative state machine.
//
//   WARMUP ──(interval timeout OR player count ≥ threshold)──▶ COUNTDOWN(5s)
//      ▲                                                            │
//      └──── COOLDOWN(5s) ◀── NAME_ENTRY(15s max) ◀── ROUND(120s) ──┘
//
// The server ticks every 250ms. On each tick we check phase deadlines and
// broadcast a `round_state` snapshot to every connected socket. Clients
// never decide phase transitions themselves — they only render what the
// server tells them.
//
// Scores: while the phase is ROUND, `recordTrick(playerId, score)` accrues
// into an in-memory per-player total. On round end, the highest total wins.

export const PHASES = {
	WARMUP:     'warmup',
	COUNTDOWN:  'countdown',
	ROUND:      'round',
	NAME_ENTRY: 'name_entry',
	COOLDOWN:   'cooldown',
};

// Cap to stop trivial score farming. 3000 points/sec is already absurdly
// higher than any natural combo we've seen locally — set generously so
// real tricks never trigger it.
const MAX_SCORE_PER_SECOND = 3000;

export class RoundManager {

	constructor( {
		roundIntervalMs,
		roundDurationMs,
		minPlayersForInstantStart,
		countdownMs = 5000,
		nameEntryMs = 15000,
		cooldownMs  = 5000,
		onBroadcast,
		onRoundWinner,
		getPlayerIds,
	} ) {

		this.cfg = {
			roundIntervalMs,
			roundDurationMs,
			minPlayersForInstantStart,
			countdownMs,
			nameEntryMs,
			cooldownMs,
		};

		this.onBroadcast   = onBroadcast;
		this.onRoundWinner = onRoundWinner;
		this.getPlayerIds  = getPlayerIds || ( () => [] );

		// Round state
		this.phase = PHASES.WARMUP;
		this.phaseStartedAt = Date.now();
		this.phaseEndsAt    = Date.now() + roundIntervalMs;
		this.roundId        = 0;
		this.roundStartedAt = 0;
		this.scores         = new Map();      // playerId -> total
		this.lastTrickAt    = new Map();      // playerId -> [ ...timestamps within last 1s ]
		this.scoreAccum1s   = new Map();      // playerId -> rolling 1s score
		this.scoreAccumBuf  = new Map();      // playerId -> [ { t, score } ... ]
		this.winner         = null;           // { playerId, score }

		this.tick = this.tick.bind( this );
		this.tickHandle = setInterval( this.tick, 250 );

	}

	stop() { clearInterval( this.tickHandle ); }

	tick() {

		const now = Date.now();

		if ( this.phase === PHASES.WARMUP ) {

			const enoughPlayers = this.getPlayerIds().length >= this.cfg.minPlayersForInstantStart;
			const timedOut = now >= this.phaseEndsAt;
			if ( enoughPlayers || timedOut ) this._enter( PHASES.COUNTDOWN, this.cfg.countdownMs );

		} else if ( now >= this.phaseEndsAt ) {

			switch ( this.phase ) {

				case PHASES.COUNTDOWN:  this._startRound(); break;
				case PHASES.ROUND:      this._endRound();   break;
				case PHASES.NAME_ENTRY: this._finalizeRound(); break;
				case PHASES.COOLDOWN:   this._enterWarmup(); break;

			}

		}

		this._broadcast();

	}

	// ─── Phase transitions ───────────────────────────────────────

	_enter( phase, durationMs ) {

		this.phase = phase;
		this.phaseStartedAt = Date.now();
		this.phaseEndsAt    = this.phaseStartedAt + durationMs;

	}

	_startRound() {

		this.roundId ++;
		this.roundStartedAt = Date.now();
		this.scores.clear();
		this.scoreAccumBuf.clear();
		this.winner = null;

		// Pre-populate score=0 for everyone currently connected so the live
		// leaderboard has rows from t=0.
		for ( const id of this.getPlayerIds() ) this.scores.set( id, 0 );

		this._enter( PHASES.ROUND, this.cfg.roundDurationMs );

	}

	_endRound() {

		// Pick the top scorer. Ties: whoever we iterated first.
		let topId = null;
		let topScore = -1;
		for ( const [ id, s ] of this.scores ) {

			if ( s > topScore ) { topScore = s; topId = id; }

		}

		this.winner = topId && topScore > 0 ? { playerId: topId, score: topScore } : null;

		if ( this.winner ) this._enter( PHASES.NAME_ENTRY, this.cfg.nameEntryMs );
		else               this._finalizeRound();   // nobody scored → skip name entry

	}

	_finalizeRound( submittedName = null ) {

		const winnerName = submittedName
			|| ( this.winner ? `anon-${ this.winner.playerId }` : null );

		if ( this.onRoundWinner ) {

			this.onRoundWinner( {
				startedAt:   this.roundStartedAt,
				endedAt:     Date.now(),
				winnerName,
				winnerScore: this.winner ? this.winner.score : 0,
				playerCount: this.scores.size,
				scores: Array.from( this.scores, ( [ id, score ] ) => ( {
					playerId: id,
					name: id === this.winner?.playerId ? winnerName : `anon-${ id }`,
					score,
				} ) ).sort( ( a, b ) => b.score - a.score ),
			} );

		}

		this._enter( PHASES.COOLDOWN, this.cfg.cooldownMs );

	}

	_enterWarmup() {

		this.phase = PHASES.WARMUP;
		this.phaseStartedAt = Date.now();
		this.phaseEndsAt    = this.phaseStartedAt + this.cfg.roundIntervalMs;
		this.scores.clear();
		this.winner = null;

	}

	// ─── Public API called from server/index.js ──────────────────

	// Apply a trick's score against a player's running total. Rejects if the
	// phase isn't ROUND, the player isn't registered, or they're firing
	// impossibly fast (simple anti-cheat — see MAX_SCORE_PER_SECOND).
	recordTrick( playerId, score ) {

		if ( this.phase !== PHASES.ROUND ) return false;
		if ( ! Number.isFinite( score ) || score <= 0 ) return false;

		// Rolling 1-second window rate limit.
		const now = Date.now();
		let buf = this.scoreAccumBuf.get( playerId );
		if ( ! buf ) { buf = []; this.scoreAccumBuf.set( playerId, buf ); }
		while ( buf.length && now - buf[ 0 ].t > 1000 ) buf.shift();
		const recentSum = buf.reduce( ( s, e ) => s + e.score, 0 );
		if ( recentSum + score > MAX_SCORE_PER_SECOND ) return false;

		buf.push( { t: now, score } );

		const current = this.scores.get( playerId ) || 0;
		this.scores.set( playerId, current + score );
		return true;

	}

	// Called by server/index.js when a peer joins mid-round so they show up
	// in the live scoreboard with zero points (instead of missing entirely).
	ensurePlayer( playerId ) {

		if ( this.phase === PHASES.ROUND && ! this.scores.has( playerId ) ) {

			this.scores.set( playerId, 0 );

		}

	}

	// Winner submits their chosen display name. Only accepted during NAME_ENTRY,
	// only from the winning playerId. Advances the state machine to COOLDOWN.
	submitName( playerId, name ) {

		if ( this.phase !== PHASES.NAME_ENTRY ) return false;
		if ( ! this.winner || this.winner.playerId !== playerId ) return false;

		const clean = sanitizeName( name );
		if ( ! clean ) return false;

		this._finalizeRound( clean );
		return true;

	}

	// Called when a peer disconnects — keep their score in the tally but stop
	// counting future ticks from them.
	dropPlayer( playerId ) {

		this.scoreAccumBuf.delete( playerId );
		// Do NOT delete this.scores — we still want the peer to appear on the
		// post-round leaderboard so spectators see the final standings.

	}

	// Snapshot used by every broadcast.
	snapshot() {

		const scoreboard = Array.from( this.scores, ( [ playerId, score ] ) => ( { playerId, score } ) )
			.sort( ( a, b ) => b.score - a.score );

		return {
			phase:         this.phase,
			phaseStartedAt: this.phaseStartedAt,
			phaseEndsAt:   this.phaseEndsAt,
			remainingMs:   Math.max( 0, this.phaseEndsAt - Date.now() ),
			roundId:       this.roundId,
			scoreboard,
			winner:        this.winner,
			playerCount:   this.getPlayerIds().length,
		};

	}

	_broadcast() { this.onBroadcast( this.snapshot() ); }

}

function sanitizeName( raw ) {

	if ( typeof raw !== 'string' ) return null;
	const trimmed = raw.trim().replace( /[^\w \-.!?]/g, '' ).slice( 0, 12 );
	return trimmed.length >= 2 ? trimmed : null;

}
