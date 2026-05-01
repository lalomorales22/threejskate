import * as THREE from 'three';
import { rigidBody } from 'crashcat';
import { DEFAULT_LOADOUT, loadoutFromPalette, applyLoadout, sanitizeLoadout } from './Loadout.js';

const _tmpVec   = new THREE.Vector3();
const _forward  = new THREE.Vector3();
const _right    = new THREE.Vector3();
const _zAxis    = new THREE.Vector3();
const _newZ     = new THREE.Vector3();
const _mat4     = new THREE.Matrix4();
const _quat     = new THREE.Quaternion();
const _invQuat  = new THREE.Quaternion();
const _up       = new THREE.Vector3( 0, 1, 0 );
const _grindLocal = new THREE.Vector3();
const _grindTarget = new THREE.Vector3();
const _grindAxis = new THREE.Vector3();
const _grindVel = new THREE.Vector3();

const LINEAR_DAMP = 0.12;
export const MAX_SPEED = 1.55;

const PUSH_ASSIST_RATE = 1.2;
export const SPHERE_RADIUS = 0.4;

// Jumps are intentionally exaggerated so flip/grab tricks have airtime to
// actually rotate and read on screen. Max vy ≈ 18 units/s vs. 1.9× gravity of
// 18 = 34.2 → ~4.7m peak with a full charge, ~1.05s airtime.
const BASE_OLLIE_VY = 9.5;
const MAX_OLLIE_CHARGE_BONUS = 8.5;
const OLLIE_CHARGE_SECONDS = 0.7;
const OLLIE_MIN_CHARGE = 0.2;
const GRIND_LOCK_RATE = 14;
const GRIND_MIN_SPEED = 1.1;

// ─── Direction quantisation ──────────────────────────────────
// The player's movement direction at the moment a trick key fires picks one
// of 9 slots: '', W, S, A, D, WA, WD, SA, SD. We reuse the same quantiser for
// every trick category.

export function quantizeDir( x, z, threshold = 0.3 ) {

	const w = z >  threshold;
	const s = z < -threshold;
	const a = x < -threshold;
	const d = x >  threshold;
	return ( w ? 'W' : s ? 'S' : '' ) + ( a ? 'A' : d ? 'D' : '' );

}

// ─── Trick catalog ───────────────────────────────────────────
//
//   vy     vertical impulse on pop (ollie only)
//   yaw    body yaw rotations in full turns (±)
//   flip   board long-axis rotations in full turns (kickflip=+1, heelflip=-1)
//   shuv   board Y-axis rotations in full turns (shuv-it=±1)
//   grab   grab pose name — applies only while the grab key is held
//   tilt   [ pitch, roll ] radians for grind board pose

export const TRICK_CATALOG = {
	ollie: {
		'':   { name: 'Ollie',        score: 100, vy: BASE_OLLIE_VY },
		'W':  { name: 'High Ollie',   score: 130, vy: 10.0 },
		'S':  { name: 'Nollie',       score: 150, vy: BASE_OLLIE_VY },
		'A':  { name: 'FS 180',       score: 200, vy: BASE_OLLIE_VY, yaw:  0.5 },
		'D':  { name: 'BS 180',       score: 200, vy: BASE_OLLIE_VY, yaw: -0.5 },
		'WA': { name: 'FS Boneless',  score: 220, vy: 9.2, yaw:  0.25, grab: 'boneless' },
		'WD': { name: 'Judo Air',     score: 220, vy: 9.2, yaw: -0.25 },
		'SA': { name: 'FS Pop Shove', score: 180, vy: BASE_OLLIE_VY, shuv:  0.5 },
		'SD': { name: 'BS Pop Shove', score: 180, vy: BASE_OLLIE_VY, shuv: -0.5 },
	},
	flip: {
		// 9 distinct boards motions — each combines a flip axis (around the
		// board's long axis) with an optional shuv (around vertical). The
		// `flip` integer controls rotation count + direction; `shuv` adds a
		// quarter/half/full turn so every direction shows a unique shape.
		'':   { name: 'Kickflip',         score: 250, flip:  1             },
		'W':  { name: 'Double Kickflip',  score: 500, flip:  2             },
		'S':  { name: 'Hardflip',         score: 450, flip:  1, shuv: -0.5 },
		'A':  { name: 'Heelflip',         score: 300, flip: -1             },
		'D':  { name: 'Double Heelflip',  score: 550, flip: -2             },
		'WA': { name: 'Laser Flip',       score: 600, flip: -1, shuv:  1   },
		'WD': { name: 'Varial Flip',      score: 450, flip:  1, shuv: -0.5 },
		'SA': { name: 'Inward Heelflip',  score: 500, flip: -1, shuv: -0.5 },
		'SD': { name: '360 Flip',         score: 600, flip:  1, shuv:  1   },
	},
	grab: {
		'':   { name: 'Indy',         score: 250, grab: 'indy' },
		'W':  { name: 'Nose Grab',    score: 280, grab: 'nose' },
		'S':  { name: 'Tail Grab',    score: 300, grab: 'tail' },
		'A':  { name: 'Melon',        score: 270, grab: 'melon' },
		'D':  { name: 'Mute',         score: 270, grab: 'mute' },
		'WA': { name: 'Stalefish',    score: 350, grab: 'stalefish' },
		'WD': { name: 'Nose Bonk',    score: 320, grab: 'nosebonk' },
		'SA': { name: 'Japan Air',    score: 450, grab: 'japan' },
		'SD': { name: 'Method',       score: 500, grab: 'method' },
	},
	grind: {
		'':   { name: '50-50',         score: 120, tilt: [  0,     0 ] },
		'W':  { name: 'Nose Grind',    score: 180, tilt: [ -0.35,  0 ] },
		'S':  { name: '5-0',           score: 180, tilt: [  0.35,  0 ] },
		'A':  { name: 'Crooked',       score: 220, tilt: [ -0.35, -0.15 ] },
		'D':  { name: 'Smith',         score: 220, tilt: [  0.35,  0.15 ] },
		'WA': { name: 'Feeble',        score: 300, tilt: [ -0.25, -0.25 ] },
		'WD': { name: 'Salad',         score: 300, tilt: [  0.25, -0.25 ] },
		'SA': { name: 'Willy',         score: 280, tilt: [  0.25,  0.25 ] },
		'SD': { name: 'Overcrook',     score: 350, tilt: [ -0.4,   0.2 ] },
	},
	slide: {
		'':   { name: 'Boardslide',     score: 160, tilt: [  0,     0.08 ], boardYaw:  Math.PI / 2 },
		'W':  { name: 'Noseslide',      score: 210, tilt: [ -0.42,  0.05 ], boardYaw:  Math.PI / 2 },
		'S':  { name: 'Tailslide',      score: 210, tilt: [  0.42,  0.05 ], boardYaw:  Math.PI / 2 },
		'A':  { name: 'Lipslide',       score: 260, tilt: [  0,    -0.12 ], boardYaw: -Math.PI / 2 },
		'D':  { name: 'Front Board',    score: 230, tilt: [  0,     0.12 ], boardYaw:  Math.PI / 2 },
		'WA': { name: 'Noseblunt',      score: 360, tilt: [ -0.45, -0.12 ], boardYaw: -Math.PI / 2 },
		'WD': { name: 'Crook Slide',    score: 320, tilt: [ -0.35,  0.18 ], boardYaw:  Math.PI / 2 },
		'SA': { name: 'Bluntslide',     score: 360, tilt: [  0.45, -0.12 ], boardYaw: -Math.PI / 2 },
		'SD': { name: 'Bigspin Slide',  score: 420, tilt: [  0.15,  0.22 ], boardYaw:  Math.PI / 2 },
	},
};

// Grab poses — target rotations for arm groups while a grab is held.
// Values are relative to the rider's local frame (rider faces local +Z).
const GRAB_POSES = {
	indy:       { armR: { x: -0.4, z: -1.3 }, tuck: 0.05 },
	mute:       { armR: { x: -1.2, z: -1.2 }, tuck: 0.05 },
	melon:      { armL: { x: -1.2, z:  1.2 }, tuck: 0.05 },
	nose:       { armR: { x: -1.9, z:  0   }, tuck: 0.0  },
	nosebonk:   { armR: { x: -1.9, z: -0.2 }, tuck: 0.0  },
	tail:       { armR: { x:  0.8, z:  0   }, tuck: 0.05 },
	stalefish:  { armL: { x:  0.5, z:  1.5 }, tuck: 0.1  },
	japan:      { armR: { x: -1.6, z: -0.8 }, tuck: 0.28 },
	method:     { armR: { x: -1.6, z: -0.8 }, armL: { x: -1.6, z: 0.8 }, tuck: 0.32 },
	boneless:   { armR: { x: -0.2, z: -1.5 }, tuck: 0.12 },
};

function flatMat( color, opts = {} ) {

	return new THREE.MeshStandardMaterial( {
		color,
		roughness: opts.roughness ?? 0.7,
		metalness: opts.metalness ?? 0.0,
		flatShading: opts.flat ?? true,
	} );

}

function lerpAngle( a, b, t ) {

	let diff = b - a;
	while ( diff >  Math.PI ) diff -= Math.PI * 2;
	while ( diff < -Math.PI ) diff += Math.PI * 2;
	return a + diff * t;

}

// ─── Procedural Skater + Skateboard ──────────────────────────
//
// The model's origin is at *wheel-bottom level*: when this container sits at
// y=0, the wheels rest on y=0. The Skater controller positions the container
// so that skater.spherePos.y - SPHERE_RADIUS = ground, which keeps the wheels
// on the floor instead of half-buried.

export function createSkaterModel( loadoutOrIndex = 0 ) {

	// Back-compat: a bare number still maps to a preset palette.
	const loadout = typeof loadoutOrIndex === 'number'
		? loadoutFromPalette( loadoutOrIndex )
		: sanitizeLoadout( loadoutOrIndex );

	const root = new THREE.Group();

	// ─── Skateboard (long axis along Z) ────────────────────
	const board = new THREE.Group();
	board.name = 'skateboard';
	board.position.y = 0.1;   // board sits just above wheel bottom

	const deckMat = flatMat( loadout.deck, { roughness: 0.55 } );
	const gripMat = flatMat( 0x0b0b0e, { roughness: 0.95, flat: false } );
	const truckMat = flatMat( 0x9a9aa4, { roughness: 0.4, metalness: 0.6, flat: false } );
	const wheelMat = flatMat( loadout.wheels, { roughness: 0.5, flat: false } );

	const deckGeo = new THREE.BoxGeometry( 0.22, 0.04, 0.82 );
	const dpos = deckGeo.attributes.position;
	for ( let i = 0; i < dpos.count; i ++ ) {

		const z = dpos.getZ( i );
		const y = dpos.getY( i );
		if ( Math.abs( z ) > 0.35 && y > 0 ) {

			dpos.setY( i, y + ( Math.abs( z ) - 0.35 ) * 0.55 );

		}

	}
	deckGeo.computeVertexNormals();

	const deck = new THREE.Mesh( deckGeo, deckMat );
	deck.castShadow = true;
	deck.receiveShadow = true;
	board.add( deck );

	const gripGeo = new THREE.BoxGeometry( 0.205, 0.005, 0.79 );
	const grip = new THREE.Mesh( gripGeo, gripMat );
	grip.position.y = 0.024;
	grip.receiveShadow = true;
	board.add( grip );

	const truckGeo = new THREE.BoxGeometry( 0.26, 0.03, 0.05 );
	const truckF = new THREE.Mesh( truckGeo, truckMat );
	truckF.position.set( 0, - 0.035, 0.28 );
	const truckB = truckF.clone();
	truckB.position.z = - 0.28;
	board.add( truckF, truckB );

	const wheelGeo = new THREE.CylinderGeometry( 0.045, 0.045, 0.045, 14 );
	wheelGeo.rotateZ( Math.PI / 2 );
	const wheelPositions = [
		[  0.13, - 0.055,  0.28 ],
		[ -0.13, - 0.055,  0.28 ],
		[  0.13, - 0.055, - 0.28 ],
		[ -0.13, - 0.055, - 0.28 ],
	];
	const wheels = [];
	for ( const [ x, y, z ] of wheelPositions ) {

		const w = new THREE.Mesh( wheelGeo, wheelMat );
		w.position.set( x, y, z );
		w.castShadow = true;
		wheels.push( w );
		board.add( w );

	}
	root.add( board );

	// ─── Rider — rotated 90° so he stands perpendicular to travel ──
	//
	// The rider's model is authored in his own local frame (facing local +Z).
	// We wrap it in `riderRoot` with rotation.y = -π/2 so that his forward
	// becomes world -X — i.e. he visibly faces the left side of the screen
	// while the board rolls along the world +Z / -Z axis.

	const riderRoot = new THREE.Group();
	riderRoot.name = 'riderRoot';
	riderRoot.rotation.y = - Math.PI / 2;
	root.add( riderRoot );

	const rider = new THREE.Group();
	rider.name = 'rider';
	rider.position.y = 0.12;
	riderRoot.add( rider );

	const shirtMat  = flatMat( loadout.shirt, { roughness: 0.75 } );
	const pantsMat  = flatMat( loadout.pants, { roughness: 0.85 } );
	const hatMat    = flatMat( loadout.hatColor, { roughness: 0.4, metalness: 0.1, flat: false } );
	const skinMat   = flatMat( loadout.skin, { roughness: 0.7 } );
	const shoeMat   = flatMat( loadout.shoes, { roughness: 0.8 } );

	// Widen the stance so feet sit over the trucks.
	// In rider-local space the rider's +X maps to world +Z (board nose).
	// The RIGHT foot is the front foot (nose) for goofy stance.
	const FRONT_FOOT_X =  0.22;
	const BACK_FOOT_X  = -0.22;

	const legGeo = new THREE.BoxGeometry( 0.075, 0.32, 0.08 );
	const legR = new THREE.Mesh( legGeo, pantsMat );
	legR.position.set( FRONT_FOOT_X, 0.16, 0 );
	legR.castShadow = true;
	const legL = legR.clone();
	legL.position.set( BACK_FOOT_X, 0.16, 0 );
	rider.add( legR, legL );

	const shoeGeo = new THREE.BoxGeometry( 0.09, 0.05, 0.18 );
	const shoeR = new THREE.Mesh( shoeGeo, shoeMat );
	shoeR.position.set( FRONT_FOOT_X, 0.02, 0 );
	shoeR.castShadow = true;
	const shoeL = shoeR.clone();
	shoeL.position.set( BACK_FOOT_X, 0.02, 0 );
	rider.add( shoeR, shoeL );

	// Torso — slightly rotated because skaters angle forward in their stance
	const torso = new THREE.Mesh( new THREE.BoxGeometry( 0.4, 0.3, 0.2 ), shirtMat );
	torso.name = 'torso';
	torso.position.y = 0.5;
	torso.castShadow = true;
	rider.add( torso );

	// Arms hang from the shoulders
	const armGeo = new THREE.BoxGeometry( 0.065, 0.3, 0.07 );
	const handGeo = new THREE.BoxGeometry( 0.08, 0.07, 0.08 );

	const armR = new THREE.Group();
	armR.name = 'armR';
	armR.position.set( 0.22, 0.63, 0 );
	const armRMesh = new THREE.Mesh( armGeo, shirtMat );
	armRMesh.position.y = - 0.14;
	armRMesh.castShadow = true;
	armR.add( armRMesh );
	const handR = new THREE.Mesh( handGeo, skinMat );
	handR.position.y = - 0.3;
	armR.add( handR );
	rider.add( armR );

	const armL = new THREE.Group();
	armL.name = 'armL';
	armL.position.set( -0.22, 0.63, 0 );
	const armLMesh = armRMesh.clone();
	armL.add( armLMesh );
	const handL = handR.clone();
	handL.position.y = - 0.3;
	armL.add( handL );
	rider.add( armL );

	// Head + helmet
	const head = new THREE.Mesh( new THREE.BoxGeometry( 0.17, 0.17, 0.17 ), skinMat );
	head.name = 'head';
	head.position.y = 0.77;
	head.castShadow = true;
	rider.add( head );

	// ─── Hats ─────────────────────────────────────────────────────
	// All three are built and the active one is toggled via visibility.
	// Swapping via .visible is cheaper than rebuilding the model on every
	// customizer tweak and sidesteps stale userData references.

	const helmet = new THREE.Mesh(
		new THREE.SphereGeometry( 0.115, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2 ),
		hatMat
	);
	helmet.position.y = 0.82;
	helmet.castShadow = true;
	rider.add( helmet );

	// Beanie — stubby cylinder with a rolled brim.
	const beanie = new THREE.Group();
	beanie.position.y = 0.84;
	const beanieCrown = new THREE.Mesh(
		new THREE.CylinderGeometry( 0.105, 0.11, 0.14, 12 ),
		hatMat
	);
	beanieCrown.castShadow = true;
	beanie.add( beanieCrown );
	const beaniePom = new THREE.Mesh(
		new THREE.SphereGeometry( 0.035, 10, 8 ),
		hatMat
	);
	beaniePom.position.y = 0.1;
	beanie.add( beaniePom );
	rider.add( beanie );

	// Cap — flat-top with a forward brim.
	const cap = new THREE.Group();
	cap.position.y = 0.84;
	const capTop = new THREE.Mesh(
		new THREE.CylinderGeometry( 0.11, 0.11, 0.08, 14 ),
		hatMat
	);
	capTop.castShadow = true;
	cap.add( capTop );
	const capBrim = new THREE.Mesh(
		new THREE.BoxGeometry( 0.22, 0.015, 0.12 ),
		hatMat
	);
	capBrim.position.set( 0, -0.02, 0.12 );
	capBrim.castShadow = true;
	cap.add( capBrim );
	rider.add( cap );

	const hats = { helmet, beanie, cap };
	// Only one visible at a time — applyLoadout handles the initial state.
	for ( const h of Object.values( hats ) ) h.visible = false;

	root.userData = {
		board,
		deck,
		riderRoot,
		rider,
		torso,
		armL,
		armR,
		head,
		helmet,   // kept for back-compat with existing references
		hats,
		legL, legR,
		shoeL, shoeR,
		wheels,
		materials: {
			shirt:    shirtMat,
			pants:    pantsMat,
			skin:     skinMat,
			shoes:    shoeMat,
			deck:     deckMat,
			wheels:   wheelMat,
			hatColor: hatMat,
		},
		loadout,
	};

	applyLoadout( root, loadout );

	return root;

}

// ─── Skater controller ───────────────────────────────────────

export class Skater {

	constructor() {

		this.linearSpeed  = 0;
		this.angularSpeed = 0;
		this.acceleration = 0;

		this.spherePos = new THREE.Vector3( 0, 0.45, 0 );
		this.sphereVel = new THREE.Vector3();

		this.rigidBody = null;
		this.physicsWorld = null;

		this.modelVelocity = new THREE.Vector3();
		this.prevModelPos  = new THREE.Vector3();

		this.container = new THREE.Group();
		this.parts = null;

		this.inputX = 0;
		this.inputZ = 0;

		// Air / trick state
		this.grounded = true;
		this.prevGrounded = true;
		this.airborne = false;
		this.airTime = 0;

		// Ollie charge
		this.ollieCrouch = 0;
		this.ollieCharge = 0;
		this.lastOllieCharge = 0;
		this.ollieQueued = null;   // { dir, vy, yaw, shuv, grab, name, score }

		// Board spin
		this.trickSpinFlip = 0;
		this.trickSpinShuv = 0;
		this.trickSpinFlipVel = 0;
		this.trickSpinShuvVel = 0;

		// Body yaw spin (for FS/BS 180, boneless tilt etc.)
		this.airYawSpin = 0;
		this.airYawSpinVel = 0;

		// Grab / grind pose
		this.grabPose = null;           // pose key
		this.grabTrickMeta = null;       // { name, score }
		this.grindActive = false;
		this.grindPose = null;           // pose key
		this.grindTrickMeta = null;
		this.grindBoardYaw = 0;
		this.grindRail = null;
		this.grindTime = 0;

		// Tuck (mid-air crouch intensity from method/japan etc.)
		this.tuckBlend = 0;

		this.driftIntensity = 0;

		// Stance: 1 = regular (left foot forward / front foot toward nose),
		//        -1 = goofy   (right foot forward). Mirrors the rider along
		// the board's long axis.
		this.stance = 1;

		// Score / combo
		this.score = 0;
		this.comboLabel = '';
		this.comboScore = 0;
		this.comboTimer = 0;
		this._airTricksThisHop = [];

		this.listeners = { trick: [] };

	}

	on( ev, fn ) { this.listeners[ ev ]?.push( fn ); }
	_emit( ev, ...args ) { for ( const fn of this.listeners[ ev ] || [] ) fn( ...args ); }

	init( loadoutOrIndex = 0 ) {

		const model = createSkaterModel( loadoutOrIndex );
		this.model = model;
		this.container.add( model );
		this.parts = model.userData;
		this.loadout = this.parts.loadout;
		return this.container;

	}

	// Swap colors/hat/trail in place. Materials mutate via applyLoadout so
	// trick poses, physics, and board animations are untouched.
	setLoadout( loadout ) {

		if ( ! this.model ) return;
		applyLoadout( this.model, loadout );
		this.loadout = this.model.userData.loadout;

	}

	// Toggle regular ↔ goofy stance. Visually mirrors the rider along the
	// board's long axis (rider-local X, which maps to world Z after the
	// riderRoot rotation). The board itself is untouched.
	toggleStance() {

		this.stance = - this.stance;
		this._applyStance();

	}

	_applyStance() {

		if ( ! this.parts || ! this.parts.riderRoot ) return;
		// riderRoot rotation applies a yaw; scale.x = -1 on it flips the
		// rider's placement along that axis. Mirroring is preserved through
		// every child transform.
		this.parts.riderRoot.scale.x = this.stance;

	}

	// Swap the procedural deck/grip/trucks/wheels visuals for a Kenney skateboard
	// model. Keeps the existing board Group parent, so every trick transform
	// (flip, shuv, grind tilt) still drives the new visual. Wheels references
	// stay intact so wheel-dust particles continue to sample the correct world
	// positions — only visibility flips.
	setKenneyBoard( kenneyGroup, { yOffset = 0, yaw = 0 } = {} ) {

		if ( ! this.parts || ! this.parts.board ) return;

		const { board, deck, wheels } = this.parts;

		// Hide procedural board geometry (keep Meshes in the tree as transform refs)
		for ( const child of board.children ) child.visible = false;
		if ( deck ) deck.visible = false;
		if ( wheels ) for ( const w of wheels ) w.visible = false;

		kenneyGroup.name = 'kenney-skateboard';
		kenneyGroup.position.y = yOffset;
		kenneyGroup.rotation.y = yaw;
		board.add( kenneyGroup );
		this.parts.kenneyBoard = kenneyGroup;

	}

	// ─── Input entry points ─────────────────────────────────

	chargeOllie( dt = 1 / 60 ) {

		// Called every frame Space is held (on the ground).
		if ( this.grounded ) {

			this.ollieCharge = THREE.MathUtils.clamp( this.ollieCharge + dt / OLLIE_CHARGE_SECONDS, 0, 1 );
			this.ollieCrouch = THREE.MathUtils.clamp( this.ollieCharge, 0, 1 );

		}

	}

	releaseOllie( dir ) {

		if ( ! this.grounded ) {

			this.ollieCharge = 0;
			this.ollieCrouch = 0;
			return;

		}

		const trick = TRICK_CATALOG.ollie[ dir ] || TRICK_CATALOG.ollie[ '' ];
		const rawCharge = THREE.MathUtils.clamp( this.ollieCharge, 0, 1 );
		const charge = Math.pow( Math.max( rawCharge, OLLIE_MIN_CHARGE ), 0.68 );
		const vy = ( trick.vy || BASE_OLLIE_VY ) + charge * MAX_OLLIE_CHARGE_BONUS;
		const score = trick.score + Math.round( charge * 85 );

		this.ollieQueued = { ...trick, dir, vy, score, charge };
		this.ollieCharge = 0;
		this.ollieCrouch = 0;

	}

	performFlip( dir ) {

		if ( ! this.airborne ) return;
		const trick = TRICK_CATALOG.flip[ dir ] || TRICK_CATALOG.flip[ '' ];

		// baseSpeed is "rotations per second". Bumped so the board visibly
		// whips through its full flip/shuv within the now-longer airtime
		// after we raised the ollie height in Phase 1.
		const airScale = 1 + this.lastOllieCharge * 0.35;
		const baseSpeed = ( trick.slow ? 2.4 : 3.6 ) * airScale;
		if ( trick.flip ) this.trickSpinFlipVel += trick.flip * Math.PI * 2 * baseSpeed;
		if ( trick.shuv ) this.trickSpinShuvVel += trick.shuv * Math.PI * 2 * baseSpeed;

		this._registerAirTrick( trick.name, trick.score );

	}

	performGrabDown( dir ) {

		if ( ! this.airborne ) return;
		const trick = TRICK_CATALOG.grab[ dir ] || TRICK_CATALOG.grab[ '' ];
		this.grabPose = trick.grab;
		this.grabTrickMeta = trick;
		this._registerAirTrick( trick.name, trick.score );

	}

	performGrabUp() {

		this.grabPose = null;
		this.grabTrickMeta = null;

	}

	performGrindDown( dir, onRail ) {

		if ( ! onRail ) return;
		const catalog = onRail.type === 'slide' ? TRICK_CATALOG.slide : TRICK_CATALOG.grind;
		const trick = catalog[ dir ] || catalog[ '' ];
		this.grindActive = true;
		this.grindPose = trick.tilt;
		this.grindTrickMeta = trick;
		this.grindBoardYaw = trick.boardYaw || 0;
		this.grindRail = onRail;
		this.grindTime = 0;
		this.airborne = false;
		this.airTime = 0;
		this._emit( 'trick', { name: trick.name, value: 0, inAir: false, grindStart: true } );

	}

	stopGrind() {

		if ( this.grindActive && this.grindTime > 0.15 ) {

			const bonus = Math.round( ( this.grindTrickMeta?.score || 120 ) + this.grindTime * 180 );
			const label = this.grindTime > 1.4
				? ( this.grindTrickMeta?.name || '50-50' ) + ' (Long)'
				: ( this.grindTrickMeta?.name || '50-50' );
			this._emit( 'trick', { name: label, value: bonus, inAir: false } );

		}
		this.grindActive = false;
		this.grindPose = null;
		this.grindTrickMeta = null;
		this.grindBoardYaw = 0;
		this.grindRail = null;
		this.grindTime = 0;

	}

	// ─── Update loop ─────────────────────────────────────────

	update( dt, input, groundCheck ) {

		this.inputX = input.x;
		this.inputZ = input.z;

		this.prevGrounded = this.grounded;
		this.grounded = groundCheck( 80 );   // coyote — ollie eligibility
		const freshContact = groundCheck( 30 );   // strict — landing detection

		const descendingIntoContact = this.sphereVel.y <= 0.15;
		if ( this.airborne && freshContact && this.airTime > 0.12 && descendingIntoContact ) {

			this._onLand();
			this.airborne = false;

		}

		if ( this.airborne ) this.airTime += dt;

		// Steering + throttle (identical feel to the car port)
		if ( input.touchActive && ( this.inputX !== 0 || this.inputZ !== 0 ) ) {

			const targetAngle = Math.atan2( this.inputX, this.inputZ );
			_quat.setFromAxisAngle( _up, targetAngle );
			this.container.quaternion.slerp( _quat, 1 - Math.exp( - 3 * dt ) );

			_forward.set( 0, 0, 1 ).applyQuaternion( this.container.quaternion );
			const cross = _forward.x * this.inputZ - _forward.z * this.inputX;
			this.inputX = - cross * 2;

			this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, MAX_SPEED, dt * PUSH_ASSIST_RATE );

		} else {

			let direction = Math.sign( this.linearSpeed );
			if ( direction === 0 ) direction = Math.abs( this.inputZ ) > 0.1 ? Math.sign( this.inputZ ) : 1;

			const steeringGrip = THREE.MathUtils.clamp( Math.abs( this.linearSpeed ), 0.2, 1.0 );
			const steerScale = this.grounded ? 3.4 : 1.2;
			const targetAngular = - this.inputX * steeringGrip * steerScale * direction;
			this.angularSpeed = THREE.MathUtils.lerp( this.angularSpeed, targetAngular, dt * 4 );

			this.container.rotateY( this.angularSpeed * dt );

			const targetSpeed = this.inputZ;

			if ( targetSpeed < 0 && this.linearSpeed > 0.01 ) {

				this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, 0.0, dt * 6 );

			} else if ( targetSpeed < 0 ) {

				this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, targetSpeed / 2, dt * 2 );

			} else {

				const rate = this.grounded ? 1.35 : 0.25;
				this.linearSpeed = THREE.MathUtils.lerp( this.linearSpeed, targetSpeed * MAX_SPEED, dt * rate );

			}

		}

		// Body yaw spin — consumed over airtime
		if ( Math.abs( this.airYawSpinVel ) > 0.001 ) {

			this.container.rotateY( this.airYawSpinVel * dt );
			// bleed the spin so it settles near its ending angle
			this.airYawSpinVel *= Math.max( 0, 1 - dt * 2.2 );

		}

		// Re-align upright if the skater's up is still mostly up
		_tmpVec.set( 0, 1, 0 ).applyQuaternion( this.container.quaternion );

		if ( _tmpVec.y > 0.5 ) {

			const targetQuat = this._alignWithY( this.container.quaternion, _up );
			this.container.quaternion.slerp( targetQuat, 0.2 );

		}

		this.linearSpeed *= Math.max( 0, 1 - LINEAR_DAMP * dt );

		if ( this.rigidBody ) {

			_forward.set( 0, 0, 1 ).applyQuaternion( this.container.quaternion );
			_forward.y = 0;
			_forward.normalize();

			_right.set( 1, 0, 0 ).applyQuaternion( this.container.quaternion );
			_right.y = 0;
			_right.normalize();

			const angvel = this.rigidBody.motionProperties.angularVelocity;
			const drive = this.linearSpeed * 110 * dt * ( this.grounded ? 1 : 0.08 );

			rigidBody.setAngularVelocity( this.physicsWorld, this.rigidBody, [
				angvel[ 0 ] + _right.x * drive,
				angvel[ 1 ],
				angvel[ 2 ] + _right.z * drive
			] );

			// Apply a queued ollie pop
			if ( this.ollieQueued && this.grounded ) {

				const q = this.ollieQueued;
				const lv = this.rigidBody.motionProperties.linearVelocity;
				const forwardBoost = 0.35 + ( q.charge || 0 ) * 0.75;
				rigidBody.setLinearVelocity( this.physicsWorld, this.rigidBody, [
					lv[ 0 ] + _forward.x * forwardBoost,
					q.vy || BASE_OLLIE_VY,
					lv[ 2 ] + _forward.z * forwardBoost,
				] );

				if ( q.yaw )  this.airYawSpinVel = q.yaw  * Math.PI * 2 * 1.6;
				if ( q.shuv ) this.trickSpinShuvVel = q.shuv * Math.PI * 2 * 2.0;
				if ( q.grab ) { this.grabPose = q.grab; this.grabTrickMeta = { name: q.name, score: q.score }; }

				this.lastOllieCharge = q.charge || 0;
				this.airborne = true;
				this.airTime = 0;
				this._airTricksThisHop.length = 0;
				this._airTricksThisHop.push( q.name );
				this._emit( 'trick', { name: q.name, value: q.score, inAir: true } );

			}
			this.ollieQueued = null;

			if ( this.grindActive && this.grindRail ) this._applyGrindLock( dt );

			const pos = this.rigidBody.position;
			this.spherePos.set( pos[ 0 ], pos[ 1 ], pos[ 2 ] );

			const vel = this.rigidBody.motionProperties.linearVelocity;
			this.sphereVel.set( vel[ 0 ], vel[ 1 ], vel[ 2 ] );

		}

		this.acceleration = THREE.MathUtils.lerp(
			this.acceleration,
			this.linearSpeed + ( 0.25 * this.linearSpeed * Math.abs( this.linearSpeed ) ),
			dt
		);

		if ( this.spherePos.y < - 6 ) this._respawn();

		// Visual placement: sphere center above ground, model origin at wheel-bottom
		this.container.position.set(
			this.spherePos.x,
			this.spherePos.y - SPHERE_RADIUS,
			this.spherePos.z
		);

		if ( dt > 0 ) {

			this.modelVelocity.subVectors( this.container.position, this.prevModelPos ).divideScalar( dt );
			this.prevModelPos.copy( this.container.position );

		}

		this._animate( dt );

		this.driftIntensity = Math.abs( this.linearSpeed - this.acceleration ) +
			( this.parts && this.parts.torso ? Math.abs( this.parts.torso.rotation.z ) * 2 : 0 );

		if ( this.grounded ) {

			this.comboTimer -= dt;
			if ( this.comboTimer <= 0 && this.comboScore > 0 ) {

				this.score += this.comboScore;
				this._emit( 'trick', { name: '', value: 0, commit: true, total: this.score } );
				this.comboScore = 0;
				this.comboLabel = '';

			}

		}

	}

	_respawn() {

		if ( this.rigidBody ) {

			rigidBody.setPosition( this.physicsWorld, this.rigidBody, [ 0, 0.8, 0 ], false );
			rigidBody.setLinearVelocity( this.physicsWorld, this.rigidBody, [ 0, 0, 0 ] );
			rigidBody.setAngularVelocity( this.physicsWorld, this.rigidBody, [ 0, 0, 0 ] );

		}

		this.spherePos.set( 0, 0.8, 0 );
		this.sphereVel.set( 0, 0, 0 );
		this.linearSpeed = 0;
		this.angularSpeed = 0;
		this.acceleration = 0;
		this.container.rotation.set( 0, 0, 0 );
		this.container.quaternion.identity();
		this.trickSpinFlip = 0;
		this.trickSpinShuv = 0;
		this.trickSpinFlipVel = 0;
		this.trickSpinShuvVel = 0;
		this.airYawSpin = 0;
		this.airYawSpinVel = 0;
		this.airborne = false;
		this.airTime = 0;
		this.grabPose = null;
		this.grabTrickMeta = null;
		this.grindActive = false;
		this.grindPose = null;
		this.grindTrickMeta = null;
		this.grindBoardYaw = 0;
		this.grindRail = null;
		this.ollieCharge = 0;
		this.ollieCrouch = 0;
		this.lastOllieCharge = 0;
		this.comboScore = 0;
		this.comboLabel = '';

	}

	_registerAirTrick( name, value ) {

		this._airTricksThisHop.push( name );
		this._emit( 'trick', { name, value, inAir: true } );

	}

	_onLand() {

		const hops = this._airTricksThisHop.length;
		if ( hops > 0 ) {

			const cleanLanding = Math.abs( this.trickSpinFlipVel ) < 3 && Math.abs( this.trickSpinShuvVel ) < 3;
			if ( cleanLanding ) this._emit( 'trick', { name: 'Clean Land', value: 60 + hops * 20, inAir: false } );

		}
		this._airTricksThisHop.length = 0;
		this.trickSpinFlipVel = 0;
		this.trickSpinShuvVel = 0;
		this.trickSpinFlip = 0;
		this.trickSpinShuv = 0;
		this.airYawSpinVel = 0;
		// Grab auto-releases on landing
		this.grabPose = null;
		this.grabTrickMeta = null;
		this.lastOllieCharge = 0;

	}

	_applyGrindLock( dt ) {

		if ( ! this.rigidBody || ! this.grindRail ) return;

		const rail = this.grindRail;
		const he = rail.halfExtents;
		const longAxisIsZ = he[ 2 ] >= he[ 0 ];
		const halfLength = longAxisIsZ ? he[ 2 ] : he[ 0 ];

		const pos = this.rigidBody.position;
		_grindLocal.set( pos[ 0 ], pos[ 1 ], pos[ 2 ] ).sub( rail.worldPos );
		_invQuat.copy( rail.quaternion ).invert();
		_grindLocal.applyQuaternion( _invQuat );

		const along = longAxisIsZ ? _grindLocal.z : _grindLocal.x;
		if ( Math.abs( along ) > halfLength + 0.8 ) {

			this.stopGrind();
			return;

		}

		const clampedAlong = THREE.MathUtils.clamp( along, -halfLength, halfLength );
		_grindTarget.set(
			longAxisIsZ ? 0 : clampedAlong,
			he[ 1 ] + SPHERE_RADIUS + 0.05,
			longAxisIsZ ? clampedAlong : 0
		);
		_grindTarget.applyQuaternion( rail.quaternion ).add( rail.worldPos );

		const lockAlpha = 1 - Math.exp( -GRIND_LOCK_RATE * dt );
		_tmpVec.set( pos[ 0 ], pos[ 1 ], pos[ 2 ] ).lerp( _grindTarget, lockAlpha );
		rigidBody.setPosition( this.physicsWorld, this.rigidBody, [ _tmpVec.x, _tmpVec.y, _tmpVec.z ], false );

		_grindAxis.set( longAxisIsZ ? 0 : 1, 0, longAxisIsZ ? 1 : 0 ).applyQuaternion( rail.quaternion );
		_grindAxis.y = 0;
		if ( _grindAxis.lengthSq() < 0.0001 ) return;
		_grindAxis.normalize();

		const lv = this.rigidBody.motionProperties.linearVelocity;
		_grindVel.set( lv[ 0 ], lv[ 1 ], lv[ 2 ] );
		let speed = _grindVel.dot( _grindAxis );

		if ( Math.abs( speed ) < GRIND_MIN_SPEED ) {

			_forward.set( 0, 0, 1 ).applyQuaternion( this.container.quaternion );
			_forward.y = 0;
			if ( _forward.lengthSq() < 0.0001 ) _forward.copy( _grindAxis );
			_forward.normalize();

			const sign = _forward.dot( _grindAxis ) >= 0 ? 1 : -1;
			speed = sign * Math.max( GRIND_MIN_SPEED, Math.abs( this.linearSpeed ) * 1.35 );

		}

		speed *= Math.max( 0, 1 - dt * 0.15 );
		rigidBody.setLinearVelocity( this.physicsWorld, this.rigidBody, [
			_grindAxis.x * speed,
			0,
			_grindAxis.z * speed,
		] );

	}

	_alignWithY( quaternion, newY ) {

		_zAxis.set( 0, 0, 1 ).applyQuaternion( quaternion );
		const xAxis = _tmpVec.crossVectors( _zAxis, newY ).negate().normalize();
		_newZ.crossVectors( xAxis, newY ).normalize();
		_mat4.makeBasis( xAxis, newY, _newZ );
		return _quat.setFromRotationMatrix( _mat4 );

	}

	_animate( dt ) {

		if ( ! this.parts ) return;

		const { board, deck, rider, torso, armL, armR, head, helmet, wheels, legL, legR, shoeL, shoeR } = this.parts;

		// Wheel spin
		const spin = this.acceleration * 1.4;
		for ( const w of wheels ) w.rotation.x += spin;

		// Lean into turns (rider-local tilt)
		const leanTarget = - this.inputX * 0.35 * Math.min( 1, Math.abs( this.linearSpeed ) * 2 );
		torso.rotation.z = lerpAngle( torso.rotation.z, leanTarget, dt * 6 );

		// Forward pitch while pushing
		const pitchTarget = this.grounded ? - Math.min( this.linearSpeed, 1 ) * 0.15 : - 0.3;
		torso.rotation.x = lerpAngle( torso.rotation.x, pitchTarget, dt * 5 );

		// Arm animation — idle swing, unless overridden by a grab pose
		const pose = this.grabPose ? GRAB_POSES[ this.grabPose ] : null;
		const tuckFromPose = pose ? ( pose.tuck || 0 ) : 0;
		this.tuckBlend = THREE.MathUtils.lerp( this.tuckBlend, tuckFromPose, dt * 8 );

		const defaultArmAngle = this.grounded ? 0.4 : 1.6;
		const armR_targetX = pose && pose.armR ? pose.armR.x : - defaultArmAngle;
		const armR_targetZ = pose && pose.armR ? pose.armR.z : - 0.15 - this.inputX * 0.5;
		const armL_targetX = pose && pose.armL ? pose.armL.x : - defaultArmAngle * 0.8;
		const armL_targetZ = pose && pose.armL ? pose.armL.z :   0.15 - this.inputX * 0.5;

		armR.rotation.x = lerpAngle( armR.rotation.x, armR_targetX, dt * 10 );
		armR.rotation.z = lerpAngle( armR.rotation.z, armR_targetZ, dt * 10 );
		armL.rotation.x = lerpAngle( armL.rotation.x, armL_targetX, dt * 10 );
		armL.rotation.z = lerpAngle( armL.rotation.z, armL_targetZ, dt * 10 );

		// Pre-ollie crouch — drops the rider
		if ( this.grounded && ! this.ollieQueued && this.ollieCharge <= 0 ) this.ollieCrouch *= Math.max( 0, 1 - dt * 1.8 );

		const crouchBlend = Math.max( this.ollieCrouch * 0.12, this.tuckBlend );
		rider.position.y = THREE.MathUtils.lerp( rider.position.y, 0.12 - crouchBlend, dt * 12 );

		// Board flip/shuv integration (only meaningful in the air)
		if ( Math.abs( this.trickSpinFlipVel ) > 0.01 || Math.abs( this.trickSpinShuvVel ) > 0.01 ) {

			this.trickSpinFlip += this.trickSpinFlipVel * dt;
			this.trickSpinShuv += this.trickSpinShuvVel * dt;
			this.trickSpinFlipVel = THREE.MathUtils.lerp( this.trickSpinFlipVel, 0, dt * 1.8 );
			this.trickSpinShuvVel = THREE.MathUtils.lerp( this.trickSpinShuvVel, 0, dt * 1.8 );

		} else if ( ! this.grounded ) {

			this.trickSpinFlip *= Math.max( 0, 1 - dt );
			this.trickSpinShuv *= Math.max( 0, 1 - dt );

		}

		// Grind tilt — board poses itself while on a rail
		if ( this.grindActive && this.grindPose ) {

			this.grindTime += dt;
			// Snap out of any flip/shuv spins while grinding
			this.trickSpinFlip = 0;
			this.trickSpinShuv = 0;

			deck.rotation.x = lerpAngle( deck.rotation.x, this.grindPose[ 0 ], dt * 10 );
			deck.rotation.z = lerpAngle( deck.rotation.z, this.grindPose[ 1 ], dt * 10 );
			board.rotation.y = lerpAngle( board.rotation.y, this.grindBoardYaw, dt * 10 );

		} else {

			board.rotation.y = this.trickSpinShuv;
			deck.rotation.z = this.trickSpinFlip;
			deck.rotation.x = lerpAngle( deck.rotation.x, 0, dt * 10 );

		}

		// Head glances in the steering direction
		head.rotation.y = lerpAngle( head.rotation.y, this.inputX * 0.4, dt * 5 );
		helmet.rotation.y = head.rotation.y;

		// Leg crouch
		legL.rotation.x = lerpAngle( legL.rotation.x, - crouchBlend * 2, dt * 8 );
		legR.rotation.x = legL.rotation.x;
		shoeL.position.y = THREE.MathUtils.lerp( shoeL.position.y, 0.02 - crouchBlend * 0.5, dt * 10 );
		shoeR.position.y = shoeL.position.y;

	}

}
