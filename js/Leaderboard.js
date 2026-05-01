// Client-side overlay that renders:
//   - the round phase banner + countdown timer
//   - the live scoreboard during a round
//   - the all-time leaderboard (Tab to toggle)
//   - the winner's name-entry modal
//
// Everything is plain DOM so it stays crisp at any canvas pixel ratio.

const PHASE_LABELS = {
	warmup:     { text: 'WARMUP',      hint: 'roll around · round starts soon' },
	countdown:  { text: 'GET READY',   hint: 'round begins in…' },
	round:      { text: 'LIVE',        hint: 'chain tricks! highest score wins' },
	name_entry: { text: 'WINNER',      hint: 'type your name' },
	cooldown:   { text: 'ROUND OVER',  hint: 'resetting…' },
};

export class Leaderboard {

	constructor( { net } ) {

		this.net = net;
		this.latest = null;          // latest round_state message
		this.showAllTime = false;
		this.allTimeCache = null;
		this.lastFetchAt  = 0;

		this._injectStyles();
		this._buildDom();
		this._bind();
		this._startTicking();

	}

	// ─── DOM ─────────────────────────────────────────────────────

	_injectStyles() {

		const css = document.createElement( 'style' );
		css.textContent = `
			#round-banner {
				position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
				background: rgba(0,0,0,0.55); color: #fff; border-radius: 10px;
				padding: 10px 22px; font: 700 16px system-ui, sans-serif;
				text-align: center; letter-spacing: 1px; pointer-events: none;
				user-select: none; z-index: 9; min-width: 220px;
			}
			#round-banner .phase { font-size: 13px; color: #ffd24a; letter-spacing: 2px; }
			#round-banner .time  { font-size: 28px; font-weight: 800; }
			#round-banner .hint  { font-size: 12px; opacity: 0.8; font-weight: 500; letter-spacing: 0.5px; }

			#scoreboard {
				position: absolute; top: 90px; right: 16px; width: 220px;
				background: rgba(0,0,0,0.45); color: #fff; border-radius: 10px;
				padding: 10px 12px; font: 600 13px system-ui, sans-serif;
				pointer-events: none; user-select: none; z-index: 9;
			}
			#scoreboard h4 { margin: 0 0 6px; font-size: 11px; letter-spacing: 2px; color: #ffd24a; }
			#scoreboard .row { display: flex; justify-content: space-between; padding: 2px 0; }
			#scoreboard .row.me { color: #ffd24a; }
			#scoreboard .row .score { font-variant-numeric: tabular-nums; }

			#all-time {
				position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
				background: rgba(10,10,18,0.92); color: #fff; border-radius: 14px;
				padding: 24px 28px; min-width: 420px; max-height: 75vh; overflow-y: auto;
				font: 500 14px system-ui, sans-serif; z-index: 20;
				box-shadow: 0 24px 64px rgba(0,0,0,0.4);
			}
			#all-time h3 { margin: 0 0 10px; font-size: 22px; letter-spacing: 1px; }
			#all-time h4 { margin: 18px 0 6px; color: #ffd24a; letter-spacing: 2px; font-size: 11px; }
			#all-time table { width: 100%; border-collapse: collapse; }
			#all-time td { padding: 4px 0; }
			#all-time td.rank { color: rgba(255,255,255,0.5); width: 28px; }
			#all-time td.score { text-align: right; font-variant-numeric: tabular-nums; font-weight: 700; }
			#all-time .close-hint { margin-top: 14px; font-size: 11px; opacity: 0.6; }

			#name-entry {
				position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
				background: linear-gradient(180deg, rgba(10,10,18,0.98), rgba(40,30,10,0.98));
				color: #fff; border-radius: 16px; padding: 28px 32px;
				font: 600 16px system-ui, sans-serif; z-index: 30; text-align: center;
				box-shadow: 0 24px 72px rgba(255, 210, 74, 0.25);
				border: 1px solid rgba(255,210,74,0.4);
			}
			#name-entry h2 { margin: 0 0 6px; font-size: 28px; letter-spacing: 2px; }
			#name-entry .score { font-size: 42px; color: #ffd24a; font-weight: 800; margin: 6px 0 14px; }
			#name-entry input {
				text-transform: uppercase; text-align: center;
				font: 700 28px system-ui, sans-serif;
				background: rgba(255,255,255,0.08); color: #fff;
				border: 2px solid rgba(255,210,74,0.6); border-radius: 8px;
				padding: 10px 16px; width: 200px; letter-spacing: 6px; outline: none;
			}
			#name-entry .deadline { margin-top: 10px; font-size: 13px; opacity: 0.7; }
			#name-entry button {
				margin-top: 14px; padding: 10px 22px; border-radius: 8px; border: none;
				background: #ffd24a; color: #1a1a22; font: 800 15px system-ui, sans-serif;
				letter-spacing: 1px; cursor: pointer;
			}
			#name-entry button:hover { background: #ffe385; }

			.hidden { display: none !important; }
		`;
		document.head.appendChild( css );

	}

	_buildDom() {

		this.banner = el( 'div', { id: 'round-banner' } );
		this.banner.innerHTML = `
			<div class="phase">—</div>
			<div class="time">—:—</div>
			<div class="hint">—</div>
		`;
		document.body.appendChild( this.banner );

		this.scoreboard = el( 'div', { id: 'scoreboard' } );
		this.scoreboard.innerHTML = `
			<h4>ROUND SCORES</h4>
			<div class="rows"></div>
		`;
		this.scoreboard.classList.add( 'hidden' );
		document.body.appendChild( this.scoreboard );

		this.allTime = el( 'div', { id: 'all-time' } );
		this.allTime.classList.add( 'hidden' );
		this.allTime.innerHTML = `
			<h3>LEADERBOARD</h3>
			<h4>TOP PLAYERS</h4>
			<table class="top"><tbody></tbody></table>
			<h4>RECENT WINNERS</h4>
			<table class="recent"><tbody></tbody></table>
			<div class="close-hint">Press <b>TAB</b> to close</div>
		`;
		document.body.appendChild( this.allTime );

		this.nameEntry = el( 'div', { id: 'name-entry' } );
		this.nameEntry.classList.add( 'hidden' );
		this.nameEntry.innerHTML = `
			<h2>ROUND WON</h2>
			<div class="score">0</div>
			<input type="text" maxlength="12" placeholder="NAME" autocomplete="off" />
			<div><button>ENTER</button></div>
			<div class="deadline">submit in —s</div>
		`;
		document.body.appendChild( this.nameEntry );

		this.nameInput  = this.nameEntry.querySelector( 'input' );
		this.nameBtn    = this.nameEntry.querySelector( 'button' );
		this.nameScore  = this.nameEntry.querySelector( '.score' );
		this.nameDeadline = this.nameEntry.querySelector( '.deadline' );

		this.nameEntryDeadline = 0;

	}

	_bind() {

		this.net.on( 'round_state', ( msg ) => { this.latest = msg; this._renderLive(); } );
		this.net.on( 'name_entry_request', ( msg ) => this._openNameEntry( msg ) );
		this.net.on( 'round_winner', () => this._closeNameEntry() );

		this.nameBtn.addEventListener( 'click', () => this._submitName() );
		this.nameInput.addEventListener( 'keydown', ( e ) => { if ( e.key === 'Enter' ) this._submitName(); } );

		window.addEventListener( 'keydown', ( e ) => {

			if ( e.code === 'Tab' ) {

				e.preventDefault();
				this._toggleAllTime();

			}

		} );

	}

	_startTicking() {

		// Update countdown numbers every 250ms so the banner looks alive even
		// between round_state broadcasts.
		setInterval( () => this._renderLive(), 250 );

	}

	// ─── Rendering ───────────────────────────────────────────────

	_renderLive() {

		if ( ! this.latest ) return;

		const phaseKey = this.latest.phase;
		const info = PHASE_LABELS[ phaseKey ] || { text: phaseKey.toUpperCase(), hint: '' };

		this.banner.querySelector( '.phase' ).textContent = info.text;
		this.banner.querySelector( '.hint'  ).textContent = info.hint;

		const remaining = Math.max( 0, Math.round( this.latest.remainingMs / 1000 ) );
		if ( phaseKey === 'warmup' ) {

			this.banner.querySelector( '.time' ).textContent = formatMMSS( remaining );

		} else {

			this.banner.querySelector( '.time' ).textContent = `${ remaining }s`;

		}

		// Scoreboard is only meaningful during/after a round.
		const showScores = phaseKey === 'round' || phaseKey === 'name_entry' || phaseKey === 'cooldown';
		this.scoreboard.classList.toggle( 'hidden', ! showScores );

		if ( showScores ) this._renderScoreboard();

		// Update name-entry deadline countdown if it's open.
		if ( ! this.nameEntry.classList.contains( 'hidden' ) && this.nameEntryDeadline ) {

			const s = Math.max( 0, Math.round( ( this.nameEntryDeadline - Date.now() ) / 1000 ) );
			this.nameDeadline.textContent = `submit in ${ s }s`;
			if ( s === 0 ) this._closeNameEntry();

		}

	}

	_renderScoreboard() {

		const rows = this.scoreboard.querySelector( '.rows' );
		const scoreboard = this.latest.scoreboard || [];
		const meId = this.net.playerId;

		rows.innerHTML = scoreboard.slice( 0, 10 ).map( ( r ) => (
			`<div class="row ${ r.playerId === meId ? 'me' : '' }">
				<span>${ escapeHtml( r.name ) }</span>
				<span class="score">${ r.score }</span>
			</div>`
		) ).join( '' ) || '<div class="row"><span>—</span></div>';

	}

	// ─── Name entry ──────────────────────────────────────────────

	_openNameEntry( msg ) {

		this.nameScore.textContent = String( msg.score || 0 );
		this.nameEntryDeadline = msg.deadlineMs || ( Date.now() + 15_000 );
		this.nameInput.value = '';
		this.nameEntry.classList.remove( 'hidden' );
		setTimeout( () => this.nameInput.focus(), 50 );

	}

	_closeNameEntry() {

		this.nameEntry.classList.add( 'hidden' );
		this.nameEntryDeadline = 0;

	}

	_submitName() {

		const val = ( this.nameInput.value || '' ).trim();
		if ( val.length < 2 ) return;
		this.net._send( { type: 'submit_name', name: val } );
		this._closeNameEntry();

	}

	// ─── All-time leaderboard ────────────────────────────────────

	async _toggleAllTime() {

		this.showAllTime = ! this.showAllTime;
		this.allTime.classList.toggle( 'hidden', ! this.showAllTime );
		if ( this.showAllTime ) await this._fetchAllTime();

	}

	async _fetchAllTime() {

		const now = performance.now();
		if ( this.allTimeCache && now - this.lastFetchAt < 3000 ) {

			this._renderAllTime( this.allTimeCache );
			return;

		}

		try {

			const res = await fetch( '/api/leaderboard?limit=20' );
			const data = await res.json();
			this.allTimeCache = data;
			this.lastFetchAt = now;
			this._renderAllTime( data );

		} catch ( err ) {

			console.warn( 'Leaderboard fetch failed', err );

		}

	}

	_renderAllTime( data ) {

		const top    = this.allTime.querySelector( '.top tbody' );
		const recent = this.allTime.querySelector( '.recent tbody' );

		top.innerHTML = ( data.top || [] ).map( ( r, i ) => (
			`<tr><td class="rank">${ i + 1 }</td><td>${ escapeHtml( r.display_name ) }</td><td>${ r.total_rounds } rounds</td><td class="score">${ r.best_score }</td></tr>`
		) ).join( '' ) || '<tr><td colspan="4">—</td></tr>';

		recent.innerHTML = ( data.recent || [] ).map( ( r ) => (
			`<tr><td>${ escapeHtml( r.name ) }</td><td>${ timeAgo( r.ended_at ) }</td><td class="score">${ r.score }</td></tr>`
		) ).join( '' ) || '<tr><td colspan="3">—</td></tr>';

	}

}

// ─── Helpers ────────────────────────────────────────────────────

function el( tag, attrs = {} ) {

	const node = document.createElement( tag );
	for ( const [ k, v ] of Object.entries( attrs ) ) node.setAttribute( k, v );
	return node;

}

function formatMMSS( totalSeconds ) {

	const m = Math.floor( totalSeconds / 60 );
	const s = totalSeconds % 60;
	return `${ m }:${ String( s ).padStart( 2, '0' ) }`;

}

function escapeHtml( s ) {

	return String( s ).replace( /[<>&"']/g, ( c ) => ( {
		'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
	}[ c ] ) );

}

function timeAgo( timestamp ) {

	const diff = Math.max( 0, Date.now() - timestamp );
	const mins = Math.floor( diff / 60000 );
	if ( mins < 1 ) return 'just now';
	if ( mins < 60 ) return `${ mins }m ago`;
	const hrs = Math.floor( mins / 60 );
	if ( hrs < 24 ) return `${ hrs }h ago`;
	return `${ Math.floor( hrs / 24 ) }d ago`;

}
