// Character customizer modal. Opens on E during warmup. Lets the player
// pick colors per slot, swap hats, choose a trail FX, or roll the whole
// thing with the big RANDOMIZE button.
//
// State flows: Customizer → callback onChange(loadout) → main.js applies
// locally, persists to localStorage, and broadcasts via net.sendProfile().

import { SWATCHES, HATS, TRAILS, DEFAULT_LOADOUT, randomLoadout, sanitizeLoadout } from './Loadout.js';

const STORAGE_KEY = 'threejskate.loadout';

export function loadStoredLoadout() {

	try {

		const raw = localStorage.getItem( STORAGE_KEY );
		if ( ! raw ) return null;
		return sanitizeLoadout( JSON.parse( raw ) );

	} catch { return null; }

}

export function persistLoadout( loadout ) {

	try { localStorage.setItem( STORAGE_KEY, JSON.stringify( loadout ) ); }
	catch {}

}

export class Customizer {

	constructor( { initialLoadout, onChange } ) {

		this.loadout = sanitizeLoadout( initialLoadout || DEFAULT_LOADOUT );
		this.onChange = onChange || ( () => {} );
		this.open = false;

		this._injectStyles();
		this._buildDom();
		this._bindKeys();
		this._render();

	}

	// ─── DOM ──────────────────────────────────────────────────

	_injectStyles() {

		const css = document.createElement( 'style' );
		css.textContent = `
			#customizer {
				position: absolute; left: 50%; top: 50%;
				transform: translate(-50%, -50%);
				background: rgba(10,10,18,0.96); color: #fff;
				border-radius: 16px; padding: 22px 26px;
				font: 600 13px system-ui, sans-serif;
				z-index: 25; width: 380px;
				box-shadow: 0 24px 64px rgba(0,0,0,0.5);
				border: 1px solid rgba(255,210,74,0.3);
			}
			#customizer.hidden { display: none; }
			#customizer h2 {
				margin: 0 0 4px; font-size: 22px; letter-spacing: 2px;
			}
			#customizer .sub { font-size: 11px; opacity: 0.6; margin-bottom: 14px; letter-spacing: 1px; }
			#customizer .row { margin-bottom: 10px; }
			#customizer .label {
				font-size: 11px; letter-spacing: 2px; color: #ffd24a;
				margin-bottom: 4px; text-transform: uppercase;
			}
			#customizer .swatches { display: flex; flex-wrap: wrap; gap: 5px; }
			#customizer .swatch {
				width: 26px; height: 26px; border-radius: 6px; cursor: pointer;
				border: 2px solid transparent; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.15);
				transition: transform 0.08s ease;
			}
			#customizer .swatch:hover { transform: scale(1.12); }
			#customizer .swatch.active { border-color: #ffd24a; transform: scale(1.08); }
			#customizer .pills { display: flex; gap: 6px; flex-wrap: wrap; }
			#customizer .pill {
				padding: 6px 12px; border-radius: 999px; cursor: pointer;
				background: rgba(255,255,255,0.08); font-size: 12px;
				border: 1px solid rgba(255,255,255,0.15);
				text-transform: uppercase; letter-spacing: 1px;
			}
			#customizer .pill:hover { background: rgba(255,255,255,0.18); }
			#customizer .pill.active {
				background: rgba(255,210,74,0.25); border-color: #ffd24a; color: #ffd24a;
			}
			#customizer .actions {
				display: flex; gap: 10px; margin-top: 18px;
				justify-content: space-between; align-items: center;
			}
			#customizer button {
				padding: 10px 18px; border-radius: 8px; border: none; cursor: pointer;
				font: 800 14px system-ui, sans-serif; letter-spacing: 1px;
			}
			#customizer .randomize {
				background: linear-gradient(135deg, #ffd24a, #f07a3c);
				color: #1a1a22; flex: 1;
			}
			#customizer .randomize:hover { filter: brightness(1.08); }
			#customizer .close {
				background: rgba(255,255,255,0.1); color: #fff;
			}
			#customizer .close:hover { background: rgba(255,255,255,0.2); }
			#customizer .hotkey { opacity: 0.5; font-size: 11px; }
		`;
		document.head.appendChild( css );

	}

	_buildDom() {

		this.root = document.createElement( 'div' );
		this.root.id = 'customizer';
		this.root.classList.add( 'hidden' );
		this.root.innerHTML = `
			<h2>CUSTOMIZE</h2>
			<div class="sub">press <span class="hotkey">F1</span> to close · <span class="hotkey">R</span> to randomize</div>

			<div class="row">
				<div class="label">Shirt</div>
				<div class="swatches" data-slot="shirt"></div>
			</div>
			<div class="row">
				<div class="label">Pants</div>
				<div class="swatches" data-slot="pants"></div>
			</div>
			<div class="row">
				<div class="label">Shoes</div>
				<div class="swatches" data-slot="shoes"></div>
			</div>
			<div class="row">
				<div class="label">Skin</div>
				<div class="swatches" data-slot="skin"></div>
			</div>
			<div class="row">
				<div class="label">Deck</div>
				<div class="swatches" data-slot="deck"></div>
			</div>
			<div class="row">
				<div class="label">Wheels</div>
				<div class="swatches" data-slot="wheels"></div>
			</div>
			<div class="row">
				<div class="label">Hat</div>
				<div class="pills" data-enum="hat"></div>
			</div>
			<div class="row">
				<div class="label">Hat color</div>
				<div class="swatches" data-slot="hatColor"></div>
			</div>
			<div class="row">
				<div class="label">Trail FX</div>
				<div class="pills" data-enum="trail"></div>
			</div>

			<div class="actions">
				<button class="randomize">🎲 RANDOMIZE</button>
				<button class="close">DONE</button>
			</div>
		`;
		document.body.appendChild( this.root );

		// Populate swatches + pills
		for ( const slot of Object.keys( SWATCHES ) ) {

			const box = this.root.querySelector( `.swatches[data-slot="${ slot }"]` );
			for ( const hex of SWATCHES[ slot ] ) {

				const dot = document.createElement( 'div' );
				dot.className = 'swatch';
				dot.style.background = '#' + hex.toString( 16 ).padStart( 6, '0' );
				dot.dataset.value = String( hex );
				dot.addEventListener( 'click', () => this._setSlot( slot, hex ) );
				box.appendChild( dot );

			}

		}

		this._buildPills( 'hat', HATS );
		this._buildPills( 'trail', TRAILS );

		this.root.querySelector( '.randomize' ).addEventListener( 'click', () => this.randomize() );
		this.root.querySelector( '.close' ).addEventListener( 'click', () => this.close() );

	}

	_buildPills( key, values ) {

		const box = this.root.querySelector( `.pills[data-enum="${ key }"]` );
		for ( const v of values ) {

			const pill = document.createElement( 'div' );
			pill.className = 'pill';
			pill.dataset.value = v;
			pill.textContent = v;
			pill.addEventListener( 'click', () => this._setEnum( key, v ) );
			box.appendChild( pill );

		}

	}

	_bindKeys() {

		window.addEventListener( 'keydown', ( e ) => {

			if ( e.target && ( e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' ) ) return;

			if ( e.code === 'F1' ) { e.preventDefault(); this.toggle(); }
			else if ( this.open && e.code === 'KeyR' ) { e.preventDefault(); this.randomize(); }
			else if ( this.open && e.code === 'Escape' ) { e.preventDefault(); this.close(); }

		} );

	}

	// ─── State mutations ─────────────────────────────────────

	_setSlot( slot, value ) {

		this.loadout = { ...this.loadout, [ slot ]: value };
		this._render();
		this._emit();

	}

	_setEnum( key, value ) {

		this.loadout = { ...this.loadout, [ key ]: value };
		this._render();
		this._emit();

	}

	randomize() {

		this.loadout = randomLoadout();
		this._render();
		this._emit();

	}

	setLoadout( loadout ) {

		this.loadout = sanitizeLoadout( loadout );
		this._render();

	}

	// ─── Visibility ──────────────────────────────────────────

	toggle() { this.open ? this.close() : this.show(); }
	show()   { this.open = true;  this.root.classList.remove( 'hidden' ); }
	close()  { this.open = false; this.root.classList.add( 'hidden' ); }

	// ─── Rendering ───────────────────────────────────────────

	_render() {

		// Active swatch per slot
		for ( const slot of Object.keys( SWATCHES ) ) {

			const current = this.loadout[ slot ];
			const swatches = this.root.querySelectorAll( `.swatches[data-slot="${ slot }"] .swatch` );
			for ( const s of swatches ) {

				s.classList.toggle( 'active', Number( s.dataset.value ) === current );

			}

		}

		// Active pill per enum
		for ( const [ key, values ] of [ [ 'hat', HATS ], [ 'trail', TRAILS ] ] ) {

			const current = this.loadout[ key ];
			const pills = this.root.querySelectorAll( `.pills[data-enum="${ key }"] .pill` );
			for ( const p of pills ) {

				p.classList.toggle( 'active', p.dataset.value === current );

			}

		}

	}

	_emit() { this.onChange( this.loadout ); }

}
