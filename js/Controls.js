import { quantizeDir } from './Skater.js';

// Controls — keyboard, gamepad, and touch. Each trick category (ollie, flip,
// grab, grind) emits edge events carrying the quantised direction held at the
// moment of the press/release.

export class Controls {

	constructor() {

		this.keys = {};
		this.x = 0;
		this.z = 0;

		// Touch state
		this.touchActive = false;
		this.touchDirX = 0;
		this.touchDirY = 0;
		this.steerPointerId = null;
		this.steerStartX = 0;
		this.steerStartY = 0;

		this.touchOllie = false;
		this.touchFlip = false;
		this.touchGrab = false;
		this.touchGrind = false;

		this._prev = { space: false, flip: false, grab: false, grind: false, stance: false };
		this._gp = { space: false, flip: false, grab: false, grind: false };

		window.addEventListener( 'keydown', ( e ) => {

			this.keys[ e.code ] = true;
			if ( [ 'Space', 'KeyJ', 'KeyK', 'KeyL', 'ShiftLeft', 'ShiftRight' ].includes( e.code ) ) e.preventDefault();

		} );
		window.addEventListener( 'keyup', ( e ) => { this.keys[ e.code ] = false; } );

		this.setupTouchUI();

	}

	setupTouchUI() {

		if ( ! ( 'ontouchstart' in window ) ) return;

		const css = document.createElement( 'style' );
		css.textContent = `
			.touch-controls { position: absolute; bottom: 0; left: 0; right: 0; height: 55%; pointer-events: none; z-index: 10; }
			.steer-zone { position: absolute; left: 0; top: 0; bottom: 0; width: 50%; pointer-events: auto; touch-action: none; }
			.steer-base { position: absolute; bottom: 32px; left: 32px; width: 150px; height: 150px; border-radius: 50%; background: rgba(255,255,255,0.1); border: 2px solid rgba(255,255,255,0.2); }
			.steer-knob { position: absolute; top: 50%; left: 50%; width: 62px; height: 62px; margin: -31px 0 0 -31px; border-radius: 50%; background: rgba(255,255,255,0.35); }
			.trick-pad { position: absolute; right: 14px; bottom: 24px; display: grid; grid-template-columns: 72px 72px; grid-template-rows: 72px 72px 60px; gap: 10px; pointer-events: auto; touch-action: none; }
			.trick-btn { border-radius: 14px; background: rgba(255,255,255,0.15); border: 2px solid rgba(255,255,255,0.3); color: #fff; font: 700 13px system-ui, sans-serif; display:flex; align-items:center; justify-content:center; user-select:none; }
			.trick-btn:active { background: rgba(255, 210, 74, 0.45); }
			.trick-btn.wide { grid-column: span 2; }
		`;
		document.head.appendChild( css );

		const container = document.createElement( 'div' );
		container.className = 'touch-controls';

		const steerZone = document.createElement( 'div' );
		steerZone.className = 'steer-zone';
		const base = document.createElement( 'div' );
		base.className = 'steer-base';
		const knob = document.createElement( 'div' );
		knob.className = 'steer-knob';
		base.appendChild( knob );
		steerZone.appendChild( base );
		container.appendChild( steerZone );

		const pad = document.createElement( 'div' );
		pad.className = 'trick-pad';

		const mkBtn = ( label, onDown, onUp, extraClass = '' ) => {

			const btn = document.createElement( 'div' );
			btn.className = 'trick-btn' + ( extraClass ? ' ' + extraClass : '' );
			btn.textContent = label;
			btn.addEventListener( 'pointerdown', ( e ) => { e.preventDefault(); onDown(); } );
			btn.addEventListener( 'pointerup', ( e ) => { e.preventDefault(); onUp && onUp(); } );
			btn.addEventListener( 'pointercancel', () => { onUp && onUp(); } );
			return btn;

		};

		pad.appendChild( mkBtn( 'FLIP', () => this.touchFlip = true ) );
		pad.appendChild( mkBtn( 'GRAB', () => this.touchGrab = true, () => this.touchGrab = false ) );
		pad.appendChild( mkBtn( 'GRIND', () => this.touchGrind = true, () => this.touchGrind = false ) );
		pad.appendChild( mkBtn( 'RESET', () => { window.location.reload(); } ) );
		pad.appendChild( mkBtn( 'OLLIE', () => this.touchOllie = true, () => this.touchOllie = false, 'wide' ) );

		container.appendChild( pad );
		document.body.appendChild( container );

		const steerRange = 44;

		steerZone.addEventListener( 'pointerdown', ( e ) => {

			if ( this.steerPointerId !== null ) return;
			steerZone.setPointerCapture( e.pointerId );
			this.steerPointerId = e.pointerId;
			this.steerStartX = e.clientX;
			this.steerStartY = e.clientY;
			this.touchActive = true;

		} );

		steerZone.addEventListener( 'pointermove', ( e ) => {

			if ( e.pointerId !== this.steerPointerId ) return;
			let dx = ( e.clientX - this.steerStartX ) / steerRange;
			let dy = ( e.clientY - this.steerStartY ) / steerRange;
			const mag = Math.sqrt( dx * dx + dy * dy );
			if ( mag > 1 ) { dx /= mag; dy /= mag; }
			this.touchDirX = dx;
			this.touchDirY = dy;
			knob.style.transform = `translate(${ dx * 60 }px, ${ dy * 60 }px)`;

		} );

		const endSteer = ( e ) => {

			if ( e.pointerId !== this.steerPointerId ) return;
			this.steerPointerId = null;
			this.touchActive = false;
			this.touchDirX = 0;
			this.touchDirY = 0;
			knob.style.transform = '';

		};

		steerZone.addEventListener( 'pointerup', endSteer );
		steerZone.addEventListener( 'pointercancel', endSteer );

	}

	update() {

		let x = 0, z = 0;

		if ( this.keys[ 'KeyA' ] || this.keys[ 'ArrowLeft' ] )  x -= 1;
		if ( this.keys[ 'KeyD' ] || this.keys[ 'ArrowRight' ] ) x += 1;
		if ( this.keys[ 'KeyW' ] || this.keys[ 'ArrowUp' ] )    z += 1;
		if ( this.keys[ 'KeyS' ] || this.keys[ 'ArrowDown' ] )  z -= 1;

		const gamepads = navigator.getGamepads();
		for ( const gp of gamepads ) {

			if ( ! gp ) continue;

			const sx = gp.axes[ 0 ];
			const sy = gp.axes[ 1 ];
			if ( Math.abs( sx ) > 0.15 ) x = sx;
			if ( Math.abs( sy ) > 0.15 ) z = - sy;

			const rt = gp.buttons[ 7 ] ? gp.buttons[ 7 ].value : 0;
			const lt = gp.buttons[ 6 ] ? gp.buttons[ 6 ].value : 0;
			if ( rt > 0.2 ) z = Math.max( z, rt );
			if ( lt > 0.2 ) z = Math.min( z, - lt );

			this._gp.space = !! ( gp.buttons[ 0 ] && gp.buttons[ 0 ].pressed );
			this._gp.flip  = !! ( gp.buttons[ 2 ] && gp.buttons[ 2 ].pressed );
			this._gp.grab  = !! ( gp.buttons[ 3 ] && gp.buttons[ 3 ].pressed );
			this._gp.grind = !! ( gp.buttons[ 5 ] && gp.buttons[ 5 ].pressed );
			break;

		}

		if ( this.touchActive ) {

			const jx = this.touchDirX;
			const jy = this.touchDirY;
			const mag = Math.sqrt( jx * jx + jy * jy );
			if ( mag > 0.15 ) {

				x = ( jx + jy ) * Math.SQRT1_2 / mag;
				z = ( - jx + jy ) * Math.SQRT1_2 / mag;

			}

		}

		this.x = x;
		this.z = z;

		const dir = quantizeDir( x, z );

		const spaceHeld = !! ( this.keys[ 'Space' ] || this.touchOllie || this._gp.space );
		const flipHeld  = !! ( this.keys[ 'KeyJ' ]  || this.touchFlip  || this._gp.flip );
		const grabHeld  = !! ( this.keys[ 'KeyK' ]  || this.touchGrab  || this._gp.grab );
		const grindHeld = !! ( this.keys[ 'KeyL' ]  || this.touchGrind || this._gp.grind );
		const stanceHeld = !! ( this.keys[ 'ShiftLeft' ] || this.keys[ 'ShiftRight' ] );

		const events = {
			dir,
			ollieHeld: spaceHeld,
			ollieDown: spaceHeld && ! this._prev.space,
			ollieUp:   ! spaceHeld && this._prev.space,
			flipDown:  flipHeld && ! this._prev.flip,
			grabDown:  grabHeld && ! this._prev.grab,
			grabUp:    ! grabHeld && this._prev.grab,
			grabHeld,
			grindDown: grindHeld && ! this._prev.grind,
			grindUp:   ! grindHeld && this._prev.grind,
			grindHeld,
			stanceToggle: stanceHeld && ! this._prev.stance,
		};

		this._prev.space  = spaceHeld;
		this._prev.flip   = flipHeld;
		this._prev.grab   = grabHeld;
		this._prev.grind  = grindHeld;
		this._prev.stance = stanceHeld;

		// One-shot touch buttons consumed this frame
		this.touchFlip = false;

		return { x, z, touchActive: this.touchActive, events };

	}

}
