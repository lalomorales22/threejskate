// Top-down 2D map editor.
//
// Opens with M. The player clicks a piece in the palette, clicks on the grid
// to drop it, right-clicks a placed piece to delete, and presses R to rotate
// the last-placed or clicked piece. Save ships the result to /api/map and
// hands back a short code; Play navigates to `/?m=<code>` to load it.

const PIECES = [
	[ 'railLow',          'Rail (low)',     '#d9c656' ],
	[ 'railHigh',         'Rail (high)',    '#c7b440' ],
	[ 'railSlope',        'Rail (slope)',   '#b39530' ],
	[ 'railCurve',        'Rail (curve)',   '#a08020' ],
	[ 'halfPipe',         'Half-pipe',      '#5d8ab8' ],
	[ 'bowlSide',         'Bowl wall',      '#7a9fc6' ],
	[ 'bowlCornerInner',  'Bowl corner ↙',  '#6a8fb8' ],
	[ 'bowlCornerOuter',  'Bowl corner ↗',  '#8ab0d0' ],
	[ 'steps',            'Stairs',         '#a8a8a8' ],
	[ 'obstacleBox',      'Box',            '#b8a070' ],
	[ 'obstacleMiddle',   'Box (mid)',      '#a89060' ],
	[ 'obstacleEnd',      'Box (end)',      '#987f50' ],
	[ 'pallet',           'Pallet',         '#c9a060' ],
	[ 'structurePlatform','Platform',       '#b0b8c0' ],
	[ 'structureWood',    'Wood platform',  '#8b6b3d' ],
];

// Approximate footprint radii for drawing. Tuned to look right at ~6 px/unit.
const PIECE_FOOTPRINTS = {
	railLow: 4.5, railHigh: 4.5, railSlope: 5.0, railCurve: 4.5,
	halfPipe: 8.5, bowlSide: 7.0, bowlCornerInner: 7.0, bowlCornerOuter: 7.0,
	steps: 5.0, obstacleBox: 3.2, obstacleMiddle: 3.2, obstacleEnd: 3.2,
	pallet: 2.6, structurePlatform: 6.0, structureWood: 6.0,
};

const ARENA_HALF = 40;           // world units shown in each direction
const CANVAS_SIZE = 520;
const PX_PER_UNIT = CANVAS_SIZE / ( ARENA_HALF * 2 );

const PIECE_COLORS = Object.fromEntries( PIECES.map( ( [ k, , c ] ) => [ k, c ] ) );

export class Editor {

	constructor() {

		this.open = false;
		this.pieces = [];
		this.selectedAsset = PIECES[ 0 ][ 0 ];
		this.selectedIndex = -1;   // index in this.pieces for rotation

		this._injectStyles();
		this._buildDom();
		this._bindKeys();
		this._draw();

	}

	// ─── DOM ──────────────────────────────────────────────────

	_injectStyles() {

		const css = document.createElement( 'style' );
		css.textContent = `
			#editor {
				position: absolute; left: 50%; top: 50%;
				transform: translate(-50%, -50%);
				background: rgba(10,10,18,0.98); color: #fff;
				border-radius: 16px; padding: 20px 22px;
				font: 600 13px system-ui, sans-serif;
				z-index: 25; width: 820px; max-width: 95vw;
				box-shadow: 0 24px 64px rgba(0,0,0,0.5);
				border: 1px solid rgba(255,210,74,0.3);
				display: flex; gap: 18px;
			}
			#editor.hidden { display: none; }
			#editor h2 { margin: 0 0 4px; font-size: 22px; letter-spacing: 2px; }
			#editor .sub { font-size: 11px; opacity: 0.6; letter-spacing: 1px; margin-bottom: 10px; }
			#editor .left { flex: 1; display: flex; flex-direction: column; }
			#editor .right { width: 220px; display: flex; flex-direction: column; gap: 6px; }
			#editor canvas { background: #1a1f2a; border-radius: 10px; image-rendering: pixelated; cursor: crosshair; display: block; }
			#editor .palette { flex: 1; overflow-y: auto; max-height: 440px; display: flex; flex-direction: column; gap: 4px; padding-right: 4px; }
			#editor .palette .p {
				padding: 7px 10px; border-radius: 6px;
				background: rgba(255,255,255,0.06); cursor: pointer;
				display: flex; align-items: center; gap: 8px;
			}
			#editor .palette .p:hover { background: rgba(255,255,255,0.15); }
			#editor .palette .p.active { background: rgba(255,210,74,0.2); border-left: 3px solid #ffd24a; }
			#editor .palette .swatch { width: 16px; height: 16px; border-radius: 4px; }
			#editor .name { font: 700 13px system-ui, sans-serif; color: #fff; }
			#editor .status {
				font-size: 11px; letter-spacing: 1px; opacity: 0.7;
				margin-top: 8px;
			}
			#editor .actions { display: flex; gap: 8px; margin-top: 10px; }
			#editor button {
				flex: 1; padding: 10px; border: none; border-radius: 6px;
				font: 800 12px system-ui, sans-serif; letter-spacing: 1px; cursor: pointer;
			}
			#editor .save { background: #ffd24a; color: #1a1a22; }
			#editor .play { background: #4ade80; color: #1a1a22; }
			#editor .clear { background: rgba(255,80,80,0.8); color: #fff; }
			#editor .close { background: rgba(255,255,255,0.1); color: #fff; }
			#editor .share {
				margin-top: 10px; padding: 8px 10px;
				background: rgba(255,210,74,0.1); border: 1px dashed rgba(255,210,74,0.4);
				border-radius: 6px; word-break: break-all; font-size: 12px;
			}
			#editor .share input {
				width: 100%; background: transparent; border: none; color: #ffd24a;
				font: 700 12px monospace; padding: 0; margin-top: 4px;
			}
			#editor label { font-size: 11px; letter-spacing: 1px; color: #ffd24a; margin-top: 4px; }
			#editor input[type="text"] {
				background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.15);
				border-radius: 6px; padding: 6px 8px; color: #fff; font: 500 12px system-ui, sans-serif;
			}
		`;
		document.head.appendChild( css );

	}

	_buildDom() {

		this.root = document.createElement( 'div' );
		this.root.id = 'editor';
		this.root.classList.add( 'hidden' );
		this.root.innerHTML = `
			<div class="left">
				<h2>MAP EDITOR</h2>
				<div class="sub">click palette → click grid to place · right-click to delete · <span style="color:#ffd24a">R</span> to rotate · <span style="color:#ffd24a">M</span> to close</div>
				<canvas width="${ CANVAS_SIZE }" height="${ CANVAS_SIZE }"></canvas>
				<div class="status">0 pieces</div>
			</div>
			<div class="right">
				<label>Map name</label>
				<input type="text" class="map-name" maxlength="40" placeholder="my dream park" />
				<label>Pieces</label>
				<div class="palette"></div>
				<div class="actions">
					<button class="save">SAVE</button>
					<button class="play">PLAY</button>
				</div>
				<div class="actions">
					<button class="clear">CLEAR</button>
					<button class="close">DONE</button>
				</div>
				<div class="share hidden"></div>
			</div>
		`;
		document.body.appendChild( this.root );

		this.canvas = this.root.querySelector( 'canvas' );
		this.ctx    = this.canvas.getContext( '2d' );
		this.statusEl = this.root.querySelector( '.status' );
		this.paletteEl = this.root.querySelector( '.palette' );
		this.nameInput = this.root.querySelector( '.map-name' );
		this.shareEl = this.root.querySelector( '.share' );

		for ( const [ key, label, color ] of PIECES ) {

			const row = document.createElement( 'div' );
			row.className = 'p' + ( key === this.selectedAsset ? ' active' : '' );
			row.dataset.key = key;
			row.innerHTML = `<div class="swatch" style="background:${ color }"></div><div class="name">${ label }</div>`;
			row.addEventListener( 'click', () => this._selectPiece( key ) );
			this.paletteEl.appendChild( row );

		}

		this.canvas.addEventListener( 'click', ( e ) => this._onCanvasClick( e ) );
		this.canvas.addEventListener( 'contextmenu', ( e ) => { e.preventDefault(); this._onCanvasRightClick( e ); } );

		this.root.querySelector( '.save' ).addEventListener( 'click', () => this._save() );
		this.root.querySelector( '.play' ).addEventListener( 'click', () => this._play() );
		this.root.querySelector( '.clear' ).addEventListener( 'click', () => this._clear() );
		this.root.querySelector( '.close' ).addEventListener( 'click', () => this.close() );

	}

	_bindKeys() {

		window.addEventListener( 'keydown', ( e ) => {

			if ( e.target && ( e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' ) && e.code !== 'Escape' ) return;

			if ( e.code === 'KeyM' ) { e.preventDefault(); this.toggle(); }
			else if ( ! this.open ) return;
			else if ( e.code === 'KeyR' ) { e.preventDefault(); this._rotateSelected(); }
			else if ( e.code === 'Escape' ) { e.preventDefault(); this.close(); }
			else if ( e.code === 'Delete' || e.code === 'Backspace' ) { e.preventDefault(); this._deleteSelected(); }

		} );

	}

	// ─── Visibility ─────────────────────────────────────────

	toggle() { this.open ? this.close() : this.show(); }
	show()   { this.open = true;  this.root.classList.remove( 'hidden' ); this._draw(); }
	close()  { this.open = false; this.root.classList.add( 'hidden' ); }

	// ─── Interactions ────────────────────────────────────────

	_selectPiece( key ) {

		this.selectedAsset = key;
		for ( const p of this.paletteEl.querySelectorAll( '.p' ) ) {
			p.classList.toggle( 'active', p.dataset.key === key );
		}

	}

	_onCanvasClick( e ) {

		const { x, z } = this._pixelToWorld( e.offsetX, e.offsetY );

		// If an existing piece is under the cursor, select it instead of placing.
		const hit = this._hitTest( x, z );
		if ( hit !== -1 ) {

			this.selectedIndex = hit;
			this._draw();
			return;

		}

		this.pieces.push( { asset: this.selectedAsset, x, z, yaw: 0 } );
		this.selectedIndex = this.pieces.length - 1;
		this._draw();

	}

	_onCanvasRightClick( e ) {

		const { x, z } = this._pixelToWorld( e.offsetX, e.offsetY );
		const hit = this._hitTest( x, z );
		if ( hit === -1 ) return;
		this.pieces.splice( hit, 1 );
		this.selectedIndex = -1;
		this._draw();

	}

	_rotateSelected() {

		if ( this.selectedIndex < 0 || this.selectedIndex >= this.pieces.length ) return;
		const p = this.pieces[ this.selectedIndex ];
		p.yaw = ( p.yaw + Math.PI / 4 ) % ( Math.PI * 2 );
		this._draw();

	}

	_deleteSelected() {

		if ( this.selectedIndex < 0 || this.selectedIndex >= this.pieces.length ) return;
		this.pieces.splice( this.selectedIndex, 1 );
		this.selectedIndex = -1;
		this._draw();

	}

	_clear() {

		if ( this.pieces.length === 0 ) return;
		if ( ! confirm( 'Clear all pieces?' ) ) return;
		this.pieces = [];
		this.selectedIndex = -1;
		this._draw();

	}

	_hitTest( x, z ) {

		for ( let i = this.pieces.length - 1; i >= 0; i -- ) {
			const p = this.pieces[ i ];
			const r = ( PIECE_FOOTPRINTS[ p.asset ] || 3 ) / 2;
			if ( Math.hypot( p.x - x, p.z - z ) < r ) return i;
		}
		return -1;

	}

	// ─── Canvas rendering ────────────────────────────────────

	_pixelToWorld( px, pz ) {

		return {
			x: ( px / PX_PER_UNIT ) - ARENA_HALF,
			z: ( pz / PX_PER_UNIT ) - ARENA_HALF,
		};

	}

	_worldToPixel( x, z ) {

		return {
			px: ( x + ARENA_HALF ) * PX_PER_UNIT,
			pz: ( z + ARENA_HALF ) * PX_PER_UNIT,
		};

	}

	_draw() {

		const ctx = this.ctx;
		ctx.fillStyle = '#1a1f2a';
		ctx.fillRect( 0, 0, CANVAS_SIZE, CANVAS_SIZE );

		// Grid
		ctx.strokeStyle = 'rgba(255,255,255,0.05)';
		ctx.lineWidth = 1;
		for ( let i = -ARENA_HALF; i <= ARENA_HALF; i += 5 ) {
			const { px } = this._worldToPixel( i, 0 );
			ctx.beginPath(); ctx.moveTo( px, 0 ); ctx.lineTo( px, CANVAS_SIZE ); ctx.stroke();
			const { pz } = this._worldToPixel( 0, i );
			ctx.beginPath(); ctx.moveTo( 0, pz ); ctx.lineTo( CANVAS_SIZE, pz ); ctx.stroke();
		}

		// Axes
		ctx.strokeStyle = 'rgba(255,210,74,0.25)';
		ctx.lineWidth = 1.5;
		const mid = CANVAS_SIZE / 2;
		ctx.beginPath(); ctx.moveTo( mid, 0 ); ctx.lineTo( mid, CANVAS_SIZE ); ctx.stroke();
		ctx.beginPath(); ctx.moveTo( 0, mid ); ctx.lineTo( CANVAS_SIZE, mid ); ctx.stroke();

		// Spawn marker
		ctx.fillStyle = '#ffd24a';
		ctx.beginPath(); ctx.arc( mid, mid, 6, 0, Math.PI * 2 ); ctx.fill();
		ctx.fillStyle = '#1a1f2a';
		ctx.font = '700 9px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
		ctx.fillText( 'S', mid, mid );

		// Pieces
		for ( let i = 0; i < this.pieces.length; i ++ ) {

			const p = this.pieces[ i ];
			const { px, pz } = this._worldToPixel( p.x, p.z );
			const r = ( PIECE_FOOTPRINTS[ p.asset ] || 3 ) * PX_PER_UNIT / 2;

			ctx.save();
			ctx.translate( px, pz );
			ctx.rotate( p.yaw );
			ctx.fillStyle = PIECE_COLORS[ p.asset ] || '#888';
			ctx.globalAlpha = i === this.selectedIndex ? 1 : 0.75;
			ctx.fillRect( -r, -r * 0.5, r * 2, r );   // wider-than-tall to hint orientation

			ctx.globalAlpha = 1;
			ctx.strokeStyle = i === this.selectedIndex ? '#ffd24a' : 'rgba(0,0,0,0.4)';
			ctx.lineWidth = i === this.selectedIndex ? 2 : 1;
			ctx.strokeRect( -r, -r * 0.5, r * 2, r );
			// Front-indicator line
			ctx.strokeStyle = 'rgba(255,255,255,0.6)';
			ctx.beginPath(); ctx.moveTo( 0, 0 ); ctx.lineTo( r, 0 ); ctx.stroke();
			ctx.restore();

		}

		this.statusEl.textContent = `${ this.pieces.length } piece${ this.pieces.length === 1 ? '' : 's' }${ this.selectedIndex >= 0 ? ' · selected' : '' }`;

	}

	// ─── Server interactions ────────────────────────────────

	async _save() {

		if ( this.pieces.length === 0 ) { alert( 'Drop at least one piece first.' ); return; }

		const name = ( this.nameInput.value || 'untitled park' ).trim().slice( 0, 40 );
		const payload = { name, pieces: this.pieces };

		try {

			const res = await fetch( '/api/map', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify( payload ),
			} );
			if ( ! res.ok ) throw new Error( `status ${ res.status }` );
			const data = await res.json();

			this.savedCode = data.code;
			this.shareEl.classList.remove( 'hidden' );
			this.shareEl.innerHTML = `
				SHAREABLE URL
				<input type="text" readonly value="${ window.location.origin }/?m=${ data.code }" />
			`;
			this.shareEl.querySelector( 'input' ).addEventListener( 'focus', ( e ) => e.target.select() );

		} catch ( err ) {

			alert( 'Save failed: ' + err.message );

		}

	}

	_play() {

		if ( ! this.savedCode ) { alert( 'Save the map first, then hit PLAY.' ); return; }
		window.location.href = `/?m=${ this.savedCode }`;

	}

}
