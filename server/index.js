import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';

import { openDatabase } from './db.js';
import { RoundManager, PHASES } from './round.js';
import { generateMap, sanitizeUserMap } from './mapgen.js';

const __dirname = path.dirname( fileURLToPath( import.meta.url ) );
const ROOT = path.resolve( __dirname, '..' );

const PORT = Number( process.env.PORT || 3000 );
const ROUND_INTERVAL_MS = Number( process.env.ROUND_INTERVAL_MS || 300_000 );
const ROUND_DURATION_MS = Number( process.env.ROUND_DURATION_MS || 120_000 );
const MIN_PLAYERS_FOR_INSTANT_START = Number( process.env.MIN_PLAYERS_FOR_INSTANT_START || 10 );
const DB_PATH = path.resolve( ROOT, process.env.DB_PATH || './data/skate.db' );

const store = openDatabase( DB_PATH );

const app = express();
app.use( express.json( { limit: '32kb' } ) );
app.use( express.static( ROOT, { extensions: [ 'html' ] } ) );

app.get( '/api/leaderboard', ( req, res ) => {

	const limit = Math.max( 1, Math.min( 100, Number( req.query.limit ) || 20 ) );
	res.json( {
		top:    store.topPlayers( limit ),
		recent: store.recentWinners( limit ),
	} );

} );

// Known Kenney prefab names live on the client (KENNEY_PREFABS). We mirror
// the set here for server-side sanitization of user-submitted maps.
const VALID_ASSET_NAMES = new Set( [
	'railLow', 'railHigh', 'railSlope', 'railCurve',
	'halfPipe', 'bowlSide', 'bowlCornerInner', 'bowlCornerOuter',
	'steps', 'obstacleBox', 'obstacleMiddle', 'obstacleEnd',
	'pallet', 'structurePlatform', 'structureWood',
] );

app.get( '/api/current-map', ( req, res ) => {

	res.json( { code: currentMapCode } );

} );

app.get( '/api/map/:code', ( req, res ) => {

	const map = store.getMap( String( req.params.code ) );
	if ( ! map ) return res.status( 404 ).json( { error: 'not found' } );
	res.json( map );

} );

app.get( '/api/maps', ( req, res ) => {

	const source = req.query.source === 'random' ? 'random' : 'user';
	const limit = Math.max( 1, Math.min( 100, Number( req.query.limit ) || 20 ) );
	res.json( { maps: store.recentMaps( source, limit ) } );

} );

app.post( '/api/map', ( req, res ) => {

	const clean = sanitizeUserMap( req.body, VALID_ASSET_NAMES );
	if ( ! clean ) return res.status( 400 ).json( { error: 'invalid map' } );

	const code = store.saveMap( {
		name: clean.name,
		source: 'user',
		data: clean,
		createdBy: null,
	} );

	res.json( { code, name: clean.name } );

} );

const server = http.createServer( app );
const wss = new WebSocketServer( { server, path: '/ws' } );

// ─── Peer registry ─────────────────────────────────────────────
//
// Each connected socket gets a stable playerId + a profile bag ({ name,
// palette, stance }) and their most recent world state. We broadcast a
// `peer_join` on hello, throttled `peer_state` fan-outs on every state msg,
// and `peer_left` on disconnect. Keep this dumb — the server is a relay in
// Phase 2 (round logic + leaderboard arrive in Phase 3).

const peers = new Map();  // playerId -> { ws, profile, state }
let nextId = 1;

function makeId() { return `p${ nextId++ }`; }

// ─── Map rotation ──────────────────────────────────────────────
// A fresh random map is rolled each time we transition into WARMUP. Players
// get to explore it during warmup, the round runs on it, then a new one is
// rolled for the next cycle. Custom user-saved maps can be surfaced by
// setting `forcedMapCode` (reserved for "map of the round" voting later).

let currentMapCode = null;
let forcedMapCode = null;

function rollRandomMap() {

	const seed = Date.now() % 0xffffff;
	const map = generateMap( seed );
	const code = store.saveMap( {
		name: map.name,
		source: 'random',
		data: map,
	} );
	return code;

}

// Seed the initial warmup with a fresh park so the very first connect has
// something to skate on.
currentMapCode = rollRandomMap();

// Round scheduler — broadcasts every tick and calls back into us on wins.
let prevPhase = null;
const round = new RoundManager( {
	roundIntervalMs: ROUND_INTERVAL_MS,
	roundDurationMs: ROUND_DURATION_MS,
	minPlayersForInstantStart: MIN_PLAYERS_FOR_INSTANT_START,
	getPlayerIds: () => Array.from( peers.keys() ),
	onBroadcast: ( snapshot ) => {

		// On every fresh entry into WARMUP, roll a new park (unless a map is
		// explicitly pinned). Players get to explore it before the round.
		if ( snapshot.phase === PHASES.WARMUP && prevPhase && prevPhase !== PHASES.WARMUP ) {

			currentMapCode = forcedMapCode || rollRandomMap();

		}
		prevPhase = snapshot.phase;

		// Enrich the scoreboard with display names so clients can render
		// without another lookup.
		const named = snapshot.scoreboard.map( ( row ) => {

			const p = peers.get( row.playerId );
			return { ...row, name: p ? p.profile.name : 'anon' };

		} );

		broadcast( 'round_state', {
			phase: snapshot.phase,
			remainingMs: snapshot.remainingMs,
			phaseEndsAt: snapshot.phaseEndsAt,
			roundId: snapshot.roundId,
			mapCode: currentMapCode,
			scoreboard: named,
			winner: snapshot.winner && {
				playerId: snapshot.winner.playerId,
				score: snapshot.winner.score,
				name: peers.get( snapshot.winner.playerId )?.profile.name || 'anon',
			},
			playerCount: snapshot.playerCount,
		} );

		// Tell the winning client to show their name-entry modal.
		if ( snapshot.phase === PHASES.NAME_ENTRY && snapshot.winner ) {

			const winnerPeer = peers.get( snapshot.winner.playerId );
			if ( winnerPeer ) {

				send( winnerPeer.ws, 'name_entry_request', {
					score: snapshot.winner.score,
					deadlineMs: snapshot.phaseEndsAt,
				} );

			}

		}

	},
	onRoundWinner: ( round ) => {

		try { store.saveRound( round ); }
		catch ( err ) { console.error( 'DB write failed', err ); }

		broadcast( 'round_winner', {
			winnerName:  round.winnerName,
			winnerScore: round.winnerScore,
			scores:      round.scores,
		} );

	},
} );

function send( ws, type, data ) {

	if ( ws.readyState !== ws.OPEN ) return;
	try { ws.send( JSON.stringify( { type, ...data } ) ); }
	catch ( err ) { /* dropped on closing socket — ignore */ }

}

function broadcast( type, data, exceptId = null ) {

	const msg = JSON.stringify( { type, ...data } );
	for ( const [ id, peer ] of peers ) {

		if ( id === exceptId ) continue;
		if ( peer.ws.readyState !== peer.ws.OPEN ) continue;
		try { peer.ws.send( msg ); } catch {}

	}

}

function profileOf( peer ) {

	return { playerId: peer.id, ...peer.profile };

}

function snapshotPeers( exceptId ) {

	const out = [];
	for ( const [ id, peer ] of peers ) {

		if ( id === exceptId ) continue;
		out.push( { ...profileOf( peer ), state: peer.state || null } );

	}
	return out;

}

wss.on( 'connection', ( ws ) => {

	const id = makeId();
	const peer = {
		id,
		ws,
		profile: { name: 'skater', palette: 0, stance: 1, loadout: null },
		state: null,
		lastStateAt: 0,
	};
	peers.set( id, peer );

	// Keep connections fresh — terminate silent ones.
	ws.isAlive = true;
	ws.on( 'pong', () => { ws.isAlive = true; } );

	ws.on( 'message', ( raw ) => {

		let msg;
		try { msg = JSON.parse( raw.toString() ); }
		catch { return; }

		if ( ! msg || typeof msg !== 'object' ) return;

		switch ( msg.type ) {

			case 'hello': {

				// Sanitize — clients can only set these fields.
				peer.profile.name    = String( msg.name || 'skater' ).slice( 0, 24 );
				peer.profile.palette = Number.isFinite( msg.palette ) ? ( msg.palette | 0 ) : 0;
				peer.profile.stance  = msg.stance === -1 ? -1 : 1;
				peer.profile.loadout = msg.loadout && typeof msg.loadout === 'object' ? msg.loadout : null;

				send( ws, 'welcome', {
					playerId: id,
					peers: snapshotPeers( id ),
					serverTime: Date.now(),
					round: { ...round.snapshot(), mapCode: currentMapCode },
				} );

				broadcast( 'peer_join', profileOf( peer ), id );

				// If they joined mid-round, seed them into the scoreboard.
				round.ensurePlayer( id );
				break;

			}
			case 'state': {

				// Expected fields: pos [x,y,z], quat [x,y,z,w], vel [x,y,z], stance
				if ( ! Array.isArray( msg.pos ) || msg.pos.length !== 3 ) return;
				if ( ! Array.isArray( msg.quat ) || msg.quat.length !== 4 ) return;

				peer.state = {
					pos: msg.pos.map( Number ),
					quat: msg.quat.map( Number ),
					vel: Array.isArray( msg.vel ) ? msg.vel.map( Number ) : [ 0, 0, 0 ],
					stance: msg.stance === -1 ? -1 : 1,
				};
				peer.profile.stance = peer.state.stance;
				peer.lastStateAt = Date.now();

				broadcast( 'peer_state', { playerId: id, ...peer.state }, id );
				break;

			}
			case 'trick': {

				const name = String( msg.name || '' ).slice( 0, 40 );
				const score = Number.isFinite( msg.score ) ? ( msg.score | 0 ) : 0;
				const combo = Number.isFinite( msg.combo ) ? ( msg.combo | 0 ) : 0;

				// Only accrue if we're in ROUND and the score passes the
				// per-second cap. Rejected tricks still fan out visually so
				// spectators see the animation — they just don't count.
				round.recordTrick( id, score );

				broadcast( 'peer_trick', { playerId: id, name, score, combo }, id );
				break;

			}
			case 'submit_name': {

				// Only the winner during NAME_ENTRY can set this.
				round.submitName( id, msg.name );
				break;

			}
			case 'profile': {

				// Live profile update — customizer changes flow through here.
				if ( typeof msg.name === 'string' ) peer.profile.name = msg.name.slice( 0, 24 );
				if ( Number.isFinite( msg.palette ) ) peer.profile.palette = msg.palette | 0;
				if ( msg.stance === 1 || msg.stance === -1 ) peer.profile.stance = msg.stance;
				if ( msg.loadout && typeof msg.loadout === 'object' ) peer.profile.loadout = msg.loadout;
				broadcast( 'peer_profile', profileOf( peer ), id );
				break;

			}
			// Unknown message types are silently ignored.
		}

	} );

	const cleanup = () => {

		if ( peers.delete( id ) ) {

			round.dropPlayer( id );
			broadcast( 'peer_left', { playerId: id } );

		}

	};
	ws.on( 'close', cleanup );
	ws.on( 'error', cleanup );

} );

// Heartbeat: ping all sockets every 20s; drop any that missed a pong.
const HEARTBEAT_MS = 20_000;
setInterval( () => {

	for ( const peer of peers.values() ) {

		const ws = peer.ws;
		if ( ws.isAlive === false ) { ws.terminate(); continue; }
		ws.isAlive = false;
		try { ws.ping(); } catch {}

	}

}, HEARTBEAT_MS );

server.listen( PORT, () => {

	console.log( `threejskate listening on http://localhost:${ PORT }` );
	console.log( `ws endpoint: ws://localhost:${ PORT }/ws` );

} );
