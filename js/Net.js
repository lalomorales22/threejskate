// Tiny WebSocket client with auto-reconnect, 15 Hz state throttling, and a
// small event bus. Kept dependency-free so it works under the same importmap
// as the rest of the client.

const STATE_SEND_HZ = 15;
const STATE_SEND_INTERVAL_MS = 1000 / STATE_SEND_HZ;

// Minimum movement/rotation delta before we bother sending another state
// frame. Static skaters cost zero bandwidth.
const POS_EPSILON = 0.01;
const QUAT_EPSILON = 0.003;

export class Net {

	constructor( { url, profile } = {} ) {

		this.url = url || defaultWsUrl();
		this.profile = profile || { name: 'skater', palette: 0, stance: 1 };

		this.playerId = null;
		this.connected = false;
		this.ws = null;

		this._reconnectDelay = 500;
		this._reconnectTimer = null;
		this._lastStateSentAt = 0;
		this._lastSent = null;  // { pos, quat, stance }

		this._listeners = {
			welcome: [],
			peer_join: [],
			peer_state: [],
			peer_trick: [],
			peer_profile: [],
			peer_left: [],
			open: [],
			close: [],
		};

		this.connect();

	}

	on( ev, fn ) {

		if ( ! this._listeners[ ev ] ) this._listeners[ ev ] = [];
		this._listeners[ ev ].push( fn );

	}

	_emit( ev, data ) {

		for ( const fn of this._listeners[ ev ] || [] ) fn( data );

	}

	connect() {

		try { this.ws = new WebSocket( this.url ); }
		catch ( err ) { this._scheduleReconnect(); return; }

		this.ws.addEventListener( 'open', () => {

			this.connected = true;
			this._reconnectDelay = 500;
			this._send( { type: 'hello', ...this.profile } );
			this._emit( 'open' );

		} );

		this.ws.addEventListener( 'message', ( ev ) => {

			let msg;
			try { msg = JSON.parse( ev.data ); }
			catch { return; }

			if ( ! msg || typeof msg !== 'object' ) return;

			if ( msg.type === 'welcome' ) this.playerId = msg.playerId;
			this._emit( msg.type, msg );

		} );

		this.ws.addEventListener( 'close', () => {

			this.connected = false;
			this._emit( 'close' );
			this._scheduleReconnect();

		} );

		this.ws.addEventListener( 'error', () => {

			// Browsers fire 'close' right after 'error'; the close handler
			// is where we schedule the reconnect.

		} );

	}

	_scheduleReconnect() {

		if ( this._reconnectTimer ) return;
		const delay = Math.min( this._reconnectDelay, 8000 );
		this._reconnectTimer = setTimeout( () => {

			this._reconnectTimer = null;
			this._reconnectDelay = Math.min( this._reconnectDelay * 2, 8000 );
			this.connect();

		}, delay );

	}

	_send( obj ) {

		if ( ! this.ws || this.ws.readyState !== WebSocket.OPEN ) return;
		try { this.ws.send( JSON.stringify( obj ) ); } catch {}

	}

	// Called every frame by main.js with the local skater's current transform.
	// Internally throttled to STATE_SEND_HZ; no-ops if the socket isn't open.
	sendState( skater ) {

		if ( ! this.connected ) return;
		const now = performance.now();
		if ( now - this._lastStateSentAt < STATE_SEND_INTERVAL_MS ) return;

		const pos = skater.spherePos;
		const quat = skater.container.quaternion;
		const vel = skater.sphereVel;
		const stance = skater.stance || 1;

		// Skip if nothing meaningful changed since last send.
		if ( this._lastSent ) {
			const p = this._lastSent.pos;
			const q = this._lastSent.quat;
			const dp = Math.abs( pos.x - p[ 0 ] ) + Math.abs( pos.y - p[ 1 ] ) + Math.abs( pos.z - p[ 2 ] );
			const dq = Math.abs( quat.x - q[ 0 ] ) + Math.abs( quat.y - q[ 1 ] ) + Math.abs( quat.z - q[ 2 ] ) + Math.abs( quat.w - q[ 3 ] );
			if ( dp < POS_EPSILON && dq < QUAT_EPSILON && stance === this._lastSent.stance ) return;
		}

		const payload = {
			type: 'state',
			pos: [ round3( pos.x ), round3( pos.y ), round3( pos.z ) ],
			quat: [ round3( quat.x ), round3( quat.y ), round3( quat.z ), round3( quat.w ) ],
			vel: [ round2( vel.x ), round2( vel.y ), round2( vel.z ) ],
			stance,
		};

		this._lastStateSentAt = now;
		this._lastSent = { pos: payload.pos, quat: payload.quat, stance };
		this._send( payload );

	}

	sendTrick( name, score, combo = 0 ) {

		this._send( { type: 'trick', name, score, combo } );

	}

	sendProfile( partial ) {

		this._send( { type: 'profile', ...partial } );

	}

}

function defaultWsUrl() {

	const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
	return `${ proto }//${ location.host }/ws`;

}

function round3( x ) { return Math.round( x * 1000 ) / 1000; }
function round2( x ) { return Math.round( x * 100 ) / 100; }
