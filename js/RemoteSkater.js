import * as THREE from 'three';
import { createSkaterModel } from './Skater.js';
import { instantiateKenney } from './Assets.js';
import { applyLoadout, sanitizeLoadout, loadoutFromPalette } from './Loadout.js';
import { TrailFX } from './Particles.js';

// Ghost renderer for a remote peer. Reuses the procedural skater model so
// each peer instantly picks up whatever local visual changes the customizer
// ships with later. State from the server is interpolated between the two
// most recent snapshots so movement stays smooth even at 15 Hz.

const SPHERE_RADIUS = 0.4;
const INTERP_DELAY_MS = 120;  // render this far behind newest snapshot

const _tmpQuatA = new THREE.Quaternion();
const _tmpQuatB = new THREE.Quaternion();

export class RemoteSkater {

	constructor( { playerId, profile = {}, scene } ) {

		this.playerId = playerId;
		this.profile = { name: 'skater', palette: 0, stance: 1, loadout: null, ...profile };

		// Loadout from the peer's hello wins. Fall back to the preset palette
		// index they joined with if they haven't opened the customizer yet.
		const seedLoadout = this.profile.loadout
			? sanitizeLoadout( this.profile.loadout )
			: loadoutFromPalette( this.profile.palette | 0 );

		this.model = createSkaterModel( seedLoadout );
		this.model.name = `remote-${ playerId }`;
		this.parts = this.model.userData;
		this.currentLoadout = seedLoadout;

		// Mirror rider for goofy stance, same mechanism as the local skater.
		if ( this.profile.stance === -1 ) this.parts.riderRoot.scale.x = -1;

		this.scene = scene;
		scene.add( this.model );

		// Each remote gets its own trail emitter so sparkles/fire/rainbow
		// render per-peer.
		this.trail = new TrailFX( scene );
		this.trail.setStyle( seedLoadout.trail || 'off' );
		this._velocity = new THREE.Vector3();

		// Fake "skater" handle fed into TrailFX.update — it only reads
		// .spherePos, .sphereVel, .container.quaternion from us.
		this._trailHandle = {
			spherePos: new THREE.Vector3(),
			sphereVel: this._velocity,
			container: this.model,
		};

		// Nameplate floating above the helmet.
		this.nameplate = makeNameplate( this.profile.name );
		this.nameplate.position.set( 0, 1.8, 0 );
		this.model.add( this.nameplate );

		// Trick pop-up that briefly appears when peer_trick fires.
		this.trickplate = makeNameplate( '', { color: '#ffd24a', size: 48 } );
		this.trickplate.position.set( 0, 2.35, 0 );
		this.trickplate.visible = false;
		this.model.add( this.trickplate );
		this._trickTimer = 0;

		// Interpolation buffer — [{ t, pos, quat }]
		this._snapshots = [];

		// Attempt to attach a Kenney board like the local skater uses. Best
		// effort: if the load fails the procedural board stays visible.
		this._attachKenneyBoard();

	}

	async _attachKenneyBoard() {

		try {

			const { group } = await instantiateKenney( 'skateboard', {
				targetFootprint: 0.82,
				alignLongestAxisTo: 'z',
				flatShading: true,
			} );
			group.position.y = -0.05;
			const { board, deck, wheels } = this.parts;
			for ( const child of board.children ) child.visible = false;
			if ( deck ) deck.visible = false;
			if ( wheels ) for ( const w of wheels ) w.visible = false;
			board.add( group );

		} catch ( err ) {

			// Procedural board stays as fallback.

		}

	}

	setProfile( profile = {} ) {

		if ( typeof profile.name === 'string' ) {

			this.profile.name = profile.name;
			updateNameplate( this.nameplate, profile.name );

		}

		if ( profile.stance === 1 || profile.stance === -1 ) {

			this.profile.stance = profile.stance;
			this.parts.riderRoot.scale.x = profile.stance;

		}

		if ( profile.loadout && typeof profile.loadout === 'object' ) {

			this.currentLoadout = sanitizeLoadout( profile.loadout );
			applyLoadout( this.model, this.currentLoadout );
			this.trail.setStyle( this.currentLoadout.trail || 'off' );

		}

	}

	pushState( state ) {

		// state = { pos, quat, vel, stance }
		this._snapshots.push( {
			t: performance.now(),
			pos: state.pos,
			quat: state.quat,
			stance: state.stance,
		} );
		// Keep buffer short — we only need the two bracketing the render time
		while ( this._snapshots.length > 8 ) this._snapshots.shift();

		if ( state.stance && state.stance !== this.profile.stance ) {

			this.profile.stance = state.stance;
			this.parts.riderRoot.scale.x = state.stance;

		}

	}

	showTrick( name ) {

		updateNameplate( this.trickplate, String( name || '' ).toUpperCase() );
		this.trickplate.visible = true;
		this._trickTimer = 1.1;

	}

	update( dt, camera ) {

		this._trickTimer -= dt;
		if ( this._trickTimer <= 0 && this.trickplate.visible ) this.trickplate.visible = false;

		// Billboards face the camera so the text stays readable.
		if ( camera ) {

			this.nameplate.lookAt( camera.position );
			this.trickplate.lookAt( camera.position );

		}

		const buf = this._snapshots;
		if ( buf.length === 0 ) return;

		const renderAt = performance.now() - INTERP_DELAY_MS;

		// Find the two snapshots bracketing renderAt
		let a = buf[ 0 ];
		let b = buf[ 0 ];
		for ( let i = 0; i < buf.length - 1; i ++ ) {

			if ( buf[ i ].t <= renderAt && buf[ i + 1 ].t >= renderAt ) {

				a = buf[ i ];
				b = buf[ i + 1 ];
				break;

			}
			if ( buf[ i + 1 ].t <= renderAt ) { a = buf[ i + 1 ]; b = buf[ i + 1 ]; }

		}

		const span = Math.max( 1, b.t - a.t );
		const tRaw = ( renderAt - a.t ) / span;
		const t = Math.max( 0, Math.min( 1, tRaw ) );

		const x = lerp( a.pos[ 0 ], b.pos[ 0 ], t );
		const y = lerp( a.pos[ 1 ], b.pos[ 1 ], t );
		const z = lerp( a.pos[ 2 ], b.pos[ 2 ], t );

		// Approximate velocity from the snapshot delta so the trail emitter
		// only fires when the peer is actually moving. span is in ms above;
		// divide by 1000 to get per-second velocity.
		const spanSec = Math.max( 0.001, ( b.t - a.t ) / 1000 );
		this._velocity.set(
			( b.pos[ 0 ] - a.pos[ 0 ] ) / spanSec,
			( b.pos[ 1 ] - a.pos[ 1 ] ) / spanSec,
			( b.pos[ 2 ] - a.pos[ 2 ] ) / spanSec,
		);

		// Match local skater model placement: origin at wheel-bottom, so drop
		// the visual by SPHERE_RADIUS from the physics sphere center.
		this.model.position.set( x, y - SPHERE_RADIUS, z );

		_tmpQuatA.set( a.quat[ 0 ], a.quat[ 1 ], a.quat[ 2 ], a.quat[ 3 ] );
		_tmpQuatB.set( b.quat[ 0 ], b.quat[ 1 ], b.quat[ 2 ], b.quat[ 3 ] );
		this.model.quaternion.copy( _tmpQuatA ).slerp( _tmpQuatB, t );

		// Trail uses remote's interpolated position + synthetic velocity.
		this._trailHandle.spherePos.set( x, y, z );
		this.trail.update( dt, this._trailHandle );

	}

	dispose( scene ) {

		scene.remove( this.model );
		this.trail?.dispose();
		this.model.traverse( ( c ) => {

			if ( c.geometry ) c.geometry.dispose?.();
			if ( c.material ) {
				const mats = Array.isArray( c.material ) ? c.material : [ c.material ];
				for ( const m of mats ) m.dispose?.();
			}

		} );

	}

}

// ─── Floating nameplate (canvas sprite) ─────────────────────────

function makeNameplate( text, { color = '#ffffff', size = 42 } = {} ) {

	const canvas = document.createElement( 'canvas' );
	canvas.width = 512;
	canvas.height = 128;
	const tex = new THREE.CanvasTexture( canvas );
	tex.colorSpace = THREE.SRGBColorSpace;
	const mat = new THREE.SpriteMaterial( { map: tex, transparent: true, depthWrite: false } );
	const sprite = new THREE.Sprite( mat );
	sprite.scale.set( 2.0, 0.5, 1 );
	sprite.userData = { canvas, tex, color, size };
	updateNameplate( sprite, text );
	return sprite;

}

function updateNameplate( sprite, text ) {

	const { canvas, tex, color, size } = sprite.userData;
	const ctx = canvas.getContext( '2d' );
	ctx.clearRect( 0, 0, canvas.width, canvas.height );
	ctx.font = `800 ${ size }px system-ui, sans-serif`;
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.lineWidth = 8;
	ctx.strokeStyle = 'rgba(0,0,0,0.8)';
	ctx.fillStyle = color;
	ctx.strokeText( text, canvas.width / 2, canvas.height / 2 );
	ctx.fillText( text, canvas.width / 2, canvas.height / 2 );
	tex.needsUpdate = true;

}

function lerp( a, b, t ) { return a + ( b - a ) * t; }
