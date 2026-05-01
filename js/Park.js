import * as THREE from 'three';
import { instantiateKenney, preloadKenneyPack } from './Assets.js';
import { generateCollidersFor, transformCollider } from './ObjColliders.js';

// ─── Grid / orientation ──────────────────────────────────────

export const CELL_RAW   = 6;
export const GRID_SCALE = 1;
export const ORIENT_DEG = { 0: 0, 1: 90, 2: 180, 3: 270 };

// Piece IDs — keep short strings for URL codec
export const PIECE_TYPES = [
	'flat',       // flat concrete tile
	'quarter',    // quarter pipe along one edge
	'bank',       // flat incline (wedge)
	'halfpipe',   // U-shaped ramp across the cell
	'rail',       // grind rail (raised metal bar)
	'ledge',      // low grindable ledge
	'stairs',     // 4-step staircase down
	'funbox',     // flat top box with ramps on 2 sides
	'pyramid',    // 4-sided ramp
	'spawn',      // flat tile, marks spawn
];

const TYPE_INDEX = {};
for ( let i = 0; i < PIECE_TYPES.length; i ++ ) TYPE_INDEX[ PIECE_TYPES[ i ] ] = i;

// ─── Default park layout ─────────────────────────────────────

export const DEFAULT_PARK = [
	// The obstacle park now comes from OBJ assets in /objects. Keep only the
	// start tile here so the older procedural ramps/rails do not appear.
	[  0,  0, 'spawn',    0 ],
];

// ─── Materials ───────────────────────────────────────────────

const MATS = {};

function materials() {

	if ( MATS.ready ) return MATS;

	MATS.concrete = new THREE.MeshStandardMaterial( { color: 0xb6b6bc, roughness: 0.92, flatShading: true } );
	MATS.concreteDark = new THREE.MeshStandardMaterial( { color: 0x8a8a92, roughness: 0.88, flatShading: true } );
	MATS.concreteEdge = new THREE.MeshStandardMaterial( { color: 0x2a2a33, roughness: 0.6, flatShading: false } );
	MATS.grass = new THREE.MeshStandardMaterial( { color: 0x7ba45a, roughness: 1.0, flatShading: true } );
	MATS.rail = new THREE.MeshStandardMaterial( { color: 0xd9c656, roughness: 0.35, metalness: 0.7 } );
	MATS.spawnAccent = new THREE.MeshStandardMaterial( { color: 0xf07a3c, roughness: 0.6, flatShading: true } );
	MATS.pool = new THREE.MeshStandardMaterial( { color: 0x5c8db8, roughness: 0.7, flatShading: true } );

	MATS.ready = true;
	return MATS;

}

// ─── Piece builders ──────────────────────────────────────────
//
// Each builder returns { mesh, colliders }.
// - mesh: a THREE.Group centered on the cell
// - colliders: array of { kind, halfExtents?, radius?, length?, position, quaternion, friction, restitution, grind? }
//
// All colliders are in *local* cell space (CELL units). Physics.js rotates and
// translates them into world space using the piece's cell position + orient.

const HALF = CELL_RAW / 2;           // 3
const RAMP_H = 1.6;                  // ramp height

function quaternionFromEuler( x, y, z ) {

	const q = new THREE.Quaternion().setFromEuler( new THREE.Euler( x, y, z ) );
	return [ q.x, q.y, q.z, q.w ];

}

// ─── Kenney Mini Skate prefabs ───────────────────────────────
//
// Each prefab loads a GLB from mini-skate/Models/GLB format/ via Assets.js,
// auto-scales to `footprint` (longest horizontal extent), and generates
// gameplay colliders from a per-prefab recipe. Recipes take the *scaled*
// bbox size { x, y, z } in the piece's local frame and return an array of
// colliders (same schema as the cell BUILDERS above).
//
// Grind colliders are the load-bearing ones: thin boxes with friction≈0.04
// and `grind: true` lock the skater into a grind when pressed L nearby.
// `grind: 'slide'` gives a lower-scoring slide surface (ledges, half-pipe
// lips).

function longAxis( size ) { return size.x >= size.z ? 'x' : 'z'; }

function grindBar( size, topY, { inset = 0.2, friction = 0.04 } = {} ) {

	const axis = longAxis( size );
	const len = ( axis === 'x' ? size.x : size.z ) - inset * 2;
	const half = len / 2;
	const thickness = 0.08;
	return axis === 'x'
		? { kind: 'box', halfExtents: [ half, 0.08, thickness ], position: [ 0, topY, 0 ], friction, grind: true }
		: { kind: 'box', halfExtents: [ thickness, 0.08, half ], position: [ 0, topY, 0 ], friction, grind: true };

}

const KENNEY_PREFABS = {

	// Rails — thin grind bars.
	railLow: {
		asset: 'rail-low',
		footprint: 4.5,
		build: ( s ) => [
			// Small supporting base so the skater can run into it from the side
			{ kind: 'box', halfExtents: sizeAlong( s, 0.5, 0.1, 0.15 ), position: [ 0, 0.1, 0 ], friction: 0.7 },
			grindBar( s, Math.max( 0.4, s.y * 0.75 ) ),
		],
	},
	railHigh: {
		asset: 'rail-high',
		footprint: 4.5,
		build: ( s ) => [
			{ kind: 'box', halfExtents: sizeAlong( s, 0.5, 0.1, 0.15 ), position: [ 0, 0.1, 0 ], friction: 0.7 },
			grindBar( s, Math.max( 0.7, s.y * 0.82 ) ),
		],
	},
	railSlope: {
		asset: 'rail-slope',
		footprint: 5.0,
		build: ( s ) => {
			// Sloped rail: approximate with two grind bars stepping up
			const axis = longAxis( s );
			const len = ( axis === 'x' ? s.x : s.z );
			const half = len / 2 - 0.25;
			const topY = Math.max( 0.9, s.y * 0.85 );
			const lowY = 0.35;
			const bar = ( a, b, y ) => {
				// box oriented with tilted axis
				const dx = b[ 0 ] - a[ 0 ];
				const dz = b[ 2 ] - a[ 2 ];
				const dy = b[ 1 ] - a[ 1 ];
				const l = Math.hypot( dx, dz );
				const hyp = Math.hypot( l, dy );
				const yaw = Math.atan2( dx, dz );
				const pitch = Math.atan2( - dy, l );
				return {
					kind: 'box',
					halfExtents: [ 0.08, 0.08, hyp / 2 ],
					position: [ ( a[ 0 ] + b[ 0 ] ) / 2, ( a[ 1 ] + b[ 1 ] ) / 2, ( a[ 2 ] + b[ 2 ] ) / 2 ],
					quaternion: quaternionFromEuler( pitch, yaw, 0 ),
					friction: 0.04,
					grind: true,
				};
			};
			if ( axis === 'x' ) {
				return [
					bar( [ - half, lowY, 0 ], [ half, topY, 0 ], 0 ),
					{ kind: 'box', halfExtents: [ half, 0.05, 0.15 ], position: [ 0, 0.05, 0 ], friction: 0.7 },
				];
			}
			return [
				bar( [ 0, lowY, - half ], [ 0, topY, half ], 0 ),
				{ kind: 'box', halfExtents: [ 0.15, 0.05, half ], position: [ 0, 0.05, 0 ], friction: 0.7 },
			];
		},
	},
	railCurve: {
		asset: 'rail-curve',
		footprint: 4.5,
		build: ( s ) => {
			// Approximate a curved rail with a couple of straight grind bars.
			// Hard to be precise without inspecting the model; this is "close enough"
			// and the rail still visibly tracks along the GLB's curve.
			const top = Math.max( 0.55, s.y * 0.8 );
			const half = Math.max( s.x, s.z ) / 2 - 0.3;
			return [
				{ kind: 'box', halfExtents: [ half * 0.6, 0.08, 0.08 ], position: [ -half * 0.4, top, -half * 0.35 ], quaternion: quaternionFromEuler( 0, 0.4, 0 ), friction: 0.04, grind: true },
				{ kind: 'box', halfExtents: [ half * 0.6, 0.08, 0.08 ], position: [  half * 0.4, top,  half * 0.35 ], quaternion: quaternionFromEuler( 0, 0.4, 0 ), friction: 0.04, grind: true },
				{ kind: 'box', halfExtents: [ s.x / 2, 0.04, s.z / 2 ], position: [ 0, 0.04, 0 ], friction: 0.7 },
			];
		},
	},

	// Ramps / pipes.
	halfPipe: {
		asset: 'half-pipe',
		footprint: 8.5,
		// Pipe length runs along Z, ramps go up along ±X — regardless of
		// how Kenney authored the GLB's internal axes.
		alignLongestAxisTo: 'z',
		build: ( s ) => {
			// U-shape: flat floor + 2 sloped walls + 2 grindable coping lips.
			const flatW = s.x * 0.34;
			const wallW = ( s.x - flatW ) / 2;
			const wallH = Math.max( 0.3, s.y - 0.1 );
			const slope = Math.atan2( wallH, wallW );
			const hyp = Math.hypot( wallH, wallW );
			const colliders = [];
			colliders.push( { kind: 'box', halfExtents: [ flatW / 2, 0.08, s.z / 2 ], position: [ 0, 0.08, 0 ], friction: 1.15 } );
			for ( const side of [ - 1, 1 ] ) {
				// Rotation sign: rotating by +slope around Z tilts a flat plate
				// so its top face points -X. For the right wall (side=+1) that's
				// toward the pipe interior — exactly what a rideable ramp needs.
				// Same logic mirrored for the left wall.
				colliders.push( {
					kind: 'box',
					halfExtents: [ hyp / 2, 0.08, s.z / 2 ],
					position: [ side * ( flatW / 2 + wallW / 2 ), wallH / 2 + 0.08, 0 ],
					quaternion: quaternionFromEuler( 0, 0, side * slope ),
					friction: 0.9,
				} );
				colliders.push( {
					kind: 'box',
					halfExtents: [ 0.08, 0.08, s.z / 2 ],
					position: [ side * ( s.x / 2 - 0.12 ), s.y + 0.02, 0 ],
					friction: 0.04, grind: true,
				} );
			}
			return colliders;
		},
	},

	// Bowl pieces — treat like curved walls. Simple approximation.
	bowlSide: {
		asset: 'bowl-side',
		footprint: 7.0,
		// Wall runs along X, depth along Z — consistent with the collider
		// recipe regardless of how Kenney authored the model.
		alignLongestAxisTo: 'x',
		build: ( s ) => {
			// A single sloped wall on the +z side, flat floor elsewhere.
			const wallH = Math.max( 0.4, s.y - 0.1 );
			const wallDepth = Math.min( s.z * 0.55, 2.2 );
			const slope = Math.atan2( wallH, wallDepth );
			const hyp = Math.hypot( wallH, wallDepth );
			return [
				{ kind: 'box', halfExtents: [ s.x / 2, 0.08, ( s.z - wallDepth ) / 2 ], position: [ 0, 0.08, - wallDepth / 2 ], friction: 1.15 },
				// Wall is on +Z side; rotation around X by -slope tilts the
				// plate so its top face points -Z (toward the bowl interior).
				{ kind: 'box', halfExtents: [ s.x / 2, 0.08, hyp / 2 ], position: [ 0, wallH / 2 + 0.08, s.z / 2 - wallDepth / 2 ], quaternion: quaternionFromEuler( - slope, 0, 0 ), friction: 0.9 },
				{ kind: 'box', halfExtents: [ s.x / 2, 0.08, 0.08 ], position: [ 0, s.y + 0.02, s.z / 2 - 0.05 ], friction: 0.04, grind: true },
			];
		},
	},
	bowlCornerInner: {
		asset: 'bowl-corner-inner',
		footprint: 7.0,
		build: ( s ) => [
			{ kind: 'box', halfExtents: [ s.x / 2, 0.08, s.z / 2 ], position: [ 0, 0.08, 0 ], friction: 1.15 },
			// Two sloped walls meeting at the inside corner (+x/+z)
			...bowlCornerWalls( s, 1, 1 ),
		],
	},
	bowlCornerOuter: {
		asset: 'bowl-corner-outer',
		footprint: 7.0,
		build: ( s ) => [
			{ kind: 'box', halfExtents: [ s.x / 2, 0.08, s.z / 2 ], position: [ 0, 0.08, 0 ], friction: 1.15 },
			...bowlCornerWalls( s, 1, 1 ),
		],
	},

	// Stairs: model an inclined plane matching the visual slope.
	steps: {
		asset: 'steps',
		footprint: 5.0,
		build: ( s ) => {
			const axis = longAxis( s );
			const len = ( axis === 'x' ? s.x : s.z );
			const slope = Math.atan2( s.y, len );
			const hyp = Math.hypot( s.y, len );
			const euler = axis === 'x'
				? [ 0, 0, - slope ]
				: [ slope, 0, 0 ];
			const he = axis === 'x'
				? [ hyp / 2, 0.08, s.z / 2 ]
				: [ s.x / 2, 0.08, hyp / 2 ];
			return [
				{
					kind: 'box',
					halfExtents: he,
					position: [ 0, s.y / 2 + 0.04, 0 ],
					quaternion: quaternionFromEuler( euler[ 0 ], euler[ 1 ], euler[ 2 ] ),
					friction: 1.0,
				},
				// Grind lip along the top edge
				axis === 'x'
					? { kind: 'box', halfExtents: [ 0.08, 0.06, s.z / 2 - 0.1 ], position: [ len / 2 - 0.1, s.y + 0.04, 0 ], friction: 0.05, grind: true }
					: { kind: 'box', halfExtents: [ s.x / 2 - 0.1, 0.06, 0.08 ], position: [ 0, s.y + 0.04, len / 2 - 0.1 ], friction: 0.05, grind: true },
			];
		},
	},

	// Obstacles — simple boxes with grindable top edges.
	obstacleBox: {
		asset: 'obstacle-box',
		footprint: 3.2,
		build: ( s ) => [
			{ kind: 'box', halfExtents: [ s.x / 2, s.y / 2, s.z / 2 ], position: [ 0, s.y / 2, 0 ], friction: 0.7, grind: 'slide' },
		],
	},
	obstacleMiddle: {
		asset: 'obstacle-middle',
		footprint: 3.2,
		build: ( s ) => [
			{ kind: 'box', halfExtents: [ s.x / 2, s.y / 2, s.z / 2 ], position: [ 0, s.y / 2, 0 ], friction: 0.7, grind: 'slide' },
		],
	},
	obstacleEnd: {
		asset: 'obstacle-end',
		footprint: 3.2,
		build: ( s ) => [
			{ kind: 'box', halfExtents: [ s.x / 2, s.y / 2, s.z / 2 ], position: [ 0, s.y / 2, 0 ], friction: 0.7, grind: 'slide' },
		],
	},
	pallet: {
		asset: 'pallet',
		footprint: 2.6,
		build: ( s ) => [
			{ kind: 'box', halfExtents: [ s.x / 2, s.y / 2, s.z / 2 ], position: [ 0, s.y / 2, 0 ], friction: 0.85 },
		],
	},

	// Raised platforms.
	structurePlatform: {
		asset: 'structure-platform',
		footprint: 6.0,
		build: ( s ) => [
			// Solid floor volume under the platform (so skater bounces off)
			{ kind: 'box', halfExtents: [ s.x / 2, s.y / 2, s.z / 2 ], position: [ 0, s.y / 2, 0 ], friction: 1.0, grind: 'slide' },
		],
	},
	structureWood: {
		asset: 'structure-wood',
		footprint: 6.0,
		build: ( s ) => [
			{ kind: 'box', halfExtents: [ s.x / 2, s.y / 2, s.z / 2 ], position: [ 0, s.y / 2, 0 ], friction: 1.0, grind: 'slide' },
		],
	},
};

// Scales the bbox size by ratios and clamps each axis to a sensible minimum.
// Used to cheaply build colliders relative to the piece's measured dimensions.
function sizeAlong( s, rx, ry, rz ) {

	return [
		Math.max( 0.1, s.x * rx ),
		Math.max( 0.05, ry ),
		Math.max( 0.1, s.z * rz ),
	];

}

function bowlCornerWalls( s, signX, signZ ) {

	const wallH = Math.max( 0.4, s.y - 0.1 );
	const wallDepth = Math.min( Math.min( s.x, s.z ) * 0.55, 2.2 );
	const slope = Math.atan2( wallH, wallDepth );
	const hyp = Math.hypot( wallH, wallDepth );
	// Rotation signs are chosen so each wall's rideable top face points back
	// toward the bowl interior (-signZ on Z walls, -signX on X walls).
	return [
		{ kind: 'box', halfExtents: [ s.x / 2, 0.08, hyp / 2 ], position: [ 0, wallH / 2 + 0.08, signZ * ( s.z / 2 - wallDepth / 2 ) ], quaternion: quaternionFromEuler( - signZ * slope, 0, 0 ), friction: 0.9 },
		{ kind: 'box', halfExtents: [ hyp / 2, 0.08, s.z / 2 ], position: [ signX * ( s.x / 2 - wallDepth / 2 ), wallH / 2 + 0.08, 0 ], quaternion: quaternionFromEuler( 0, 0, signX * slope ), friction: 0.9 },
	];

}

export function kenneyAsset( prefabName, id, position, yaw = 0, overrides = {} ) {

	const base = KENNEY_PREFABS[ prefabName ];
	if ( ! base ) throw new Error( `Unknown Kenney prefab: ${ prefabName }` );
	return {
		...base,
		...overrides,
		prefabName,
		id,
		position,
		yaw,
	};

}

// Convert a server map payload ({ pieces: [{ asset, x, z, yaw }, ...] }) into
// the scatter array shape used by buildPark / loadObjectAssets. `asset` is a
// prefab key (e.g. 'railLow') that must exist in KENNEY_PREFABS — unknown
// entries are skipped silently so a bad serialized map never crashes the
// client.
export function scatterFromMapData( mapData ) {

	if ( ! mapData || ! Array.isArray( mapData.pieces ) ) return [];
	const scatter = [];
	for ( let i = 0; i < mapData.pieces.length; i ++ ) {
		const p = mapData.pieces[ i ];
		if ( ! p || ! KENNEY_PREFABS[ p.asset ] ) continue;
		scatter.push( kenneyAsset( p.asset, `${ p.asset }-${ i }`, [ Number( p.x ) || 0, 0, Number( p.z ) || 0 ], Number( p.yaw ) || 0 ) );
	}
	return scatter;

}

// Default Kenney skate park layout — a scattered "bring-your-friends" map.
// Positions are world-space; yaw rotates around Y. Each entry renders a single
// instance of the named prefab.
const KENNEY_SCATTER = [
	// Rails ring near spawn — plenty of easy grinds
	kenneyAsset( 'railLow',    'rail-low-a',     [   6, 0,  10 ], 0 ),
	kenneyAsset( 'railLow',    'rail-low-b',     [ -10, 0,  -8 ], Math.PI / 2 ),
	kenneyAsset( 'railHigh',   'rail-high-a',    [  14, 0,  -6 ], Math.PI / 2 ),
	kenneyAsset( 'railHigh',   'rail-high-b',    [ -14, 0,  12 ], 0 ),
	kenneyAsset( 'railSlope',  'rail-slope-a',   [  -4, 0,  20 ], 0 ),
	kenneyAsset( 'railCurve',  'rail-curve-a',   [  20, 0,   8 ], Math.PI / 3 ),

	// Ramps
	kenneyAsset( 'halfPipe',   'halfpipe-a',     [  22, 0,  -18 ], 0 ),
	kenneyAsset( 'halfPipe',   'halfpipe-b',     [ -24, 0,   22 ], Math.PI / 2 ),

	// Bowl cluster (not a closed bowl — just the pieces scattered so they read)
	kenneyAsset( 'bowlSide',        'bowl-side-a',   [ -20, 0, -18 ], 0 ),
	kenneyAsset( 'bowlCornerInner', 'bowl-inner-a',  [ -27, 0, -18 ], - Math.PI / 2 ),
	kenneyAsset( 'bowlCornerOuter', 'bowl-outer-a',  [ -14, 0, -25 ], Math.PI ),

	// Stairs
	kenneyAsset( 'steps',      'steps-a',        [   0, 0, -22 ], 0 ),
	kenneyAsset( 'steps',      'steps-b',        [  30, 0,  10 ], Math.PI / 2 ),

	// Boxes + palette clutter — good for filler grinds / tech lines
	kenneyAsset( 'obstacleBox',    'box-a',      [   4, 0,  -6 ], 0 ),
	kenneyAsset( 'obstacleMiddle', 'box-b',      [  -6, 0,  -4 ], 0 ),
	kenneyAsset( 'obstacleEnd',    'box-c',      [   8, 0,   4 ], Math.PI / 4 ),
	kenneyAsset( 'pallet',         'pallet-a',   [  12, 0,  14 ], 0 ),
	kenneyAsset( 'pallet',         'pallet-b',   [ -12, 0,   4 ], Math.PI / 4 ),

	// Platforms — raised features to jump onto
	kenneyAsset( 'structurePlatform', 'platform-a', [  26, 0,  24 ], 0 ),
	kenneyAsset( 'structureWood',     'platform-b', [ -26, 0,   2 ], Math.PI / 2 ),
];

function cloneColliders( colliders ) {

	return colliders.map( ( c ) => ( {
		...c,
		halfExtents: [ ...c.halfExtents ],
		position: [ ...c.position ],
		quaternion: c.quaternion ? [ ...c.quaternion ] : undefined,
	} ) );

}

function buildFlat() {

	const group = new THREE.Group();
	const { concrete } = materials();

	const geo = new THREE.BoxGeometry( CELL_RAW, 0.4, CELL_RAW );
	const mesh = new THREE.Mesh( geo, concrete );
	mesh.position.y = - 0.2;
	mesh.receiveShadow = true;
	group.add( mesh );

	const colliders = [
		{ kind: 'box', halfExtents: [ HALF, 0.2, HALF ], position: [ 0, - 0.2, 0 ], friction: 1.2, restitution: 0.0 }
	];

	return { mesh: group, colliders };

}

function buildSpawn() {

	const { colliders, mesh } = buildFlat();
	const { spawnAccent } = materials();

	const ring = new THREE.Mesh(
		new THREE.RingGeometry( 1.2, 1.5, 32 ),
		new THREE.MeshBasicMaterial( { color: 0xf07a3c, transparent: true, opacity: 0.55, side: THREE.DoubleSide } )
	);
	ring.rotation.x = - Math.PI / 2;
	ring.position.y = 0.02;
	mesh.add( ring );

	const arrow = new THREE.Mesh( new THREE.ConeGeometry( 0.35, 0.7, 4 ), spawnAccent );
	arrow.rotation.x = Math.PI / 2;
	arrow.position.set( 0, 0.1, 0.9 );
	mesh.add( arrow );

	return { mesh, colliders };

}

function buildQuarter() {

	// A curved ramp that rises along +z, with the concave face pointing -z.
	// The skater rolls up the ramp's curve.
	const group = new THREE.Group();
	const { concrete, concreteEdge } = materials();

	const r = RAMP_H;                  // ramp radius = height
	const segments = 10;
	const depth = CELL_RAW;            // along X

	// Build a 2D arc profile (side view) and extrude along X
	const shape = new THREE.Shape();
	shape.moveTo( HALF, 0 );
	shape.lineTo( HALF - r, 0 );
	// Arc from bottom (HALF - r, 0) up to top at (HALF, r)
	const arcPts = [];
	for ( let i = 0; i <= segments; i ++ ) {

		const a = Math.PI + ( i / segments ) * ( Math.PI / 2 );   // π .. 3π/2
		arcPts.push( new THREE.Vector2( HALF + r * Math.cos( a ), r + r * Math.sin( a ) ) );

	}
	for ( const p of arcPts ) shape.lineTo( p.x, p.y );
	shape.lineTo( HALF, r );
	shape.lineTo( HALF, 0 );

	const extrude = new THREE.ExtrudeGeometry( shape, { depth, bevelEnabled: false, curveSegments: segments } );
	extrude.translate( 0, 0, - depth / 2 );
	extrude.rotateY( Math.PI / 2 );

	const mesh = new THREE.Mesh( extrude, concrete );
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	group.add( mesh );

	// Coping at the top lip
	const coping = new THREE.Mesh(
		new THREE.CylinderGeometry( 0.06, 0.06, CELL_RAW, 10 ),
		concreteEdge
	);
	coping.rotation.z = Math.PI / 2;
	coping.position.set( HALF - 0.04, RAMP_H + 0.01, 0 );
	group.add( coping );

	// Floor underneath (so skater on the flat side doesn't fall through)
	const floor = new THREE.Mesh(
		new THREE.BoxGeometry( CELL_RAW - r, 0.4, CELL_RAW ),
		concrete
	);
	floor.position.set( - r / 2, - 0.2, 0 );
	floor.receiveShadow = true;
	group.add( floor );

	// Colliders — approximate the curve with 4 tilted boxes + a back wall + a floor
	const colliders = [];
	// Base floor (flat)
	colliders.push( { kind: 'box', halfExtents: [ ( CELL_RAW - r ) / 2, 0.2, HALF ], position: [ - r / 2, - 0.2, 0 ], friction: 1.2 } );

	// Ramp segments: tilt planes tangent to the arc at each angle
	for ( let i = 0; i < segments; i ++ ) {

		const a = Math.PI + ( ( i + 0.5 ) / segments ) * ( Math.PI / 2 );
		const cx = HALF + r * Math.cos( a );
		const cy = r + r * Math.sin( a );
		const tangentAngle = a - Math.PI / 2;  // plane normal points outward along (cos a, sin a)

		const segLen = ( r * ( Math.PI / 2 ) ) / segments;
		const halfExtents = [ 0.1, segLen / 2, HALF ];
		const pos = [ cx + Math.cos( a ) * 0.1, cy + Math.sin( a ) * 0.1, 0 ];
		const q = quaternionFromEuler( 0, 0, tangentAngle - Math.PI / 2 );

		colliders.push( { kind: 'box', halfExtents, position: pos, quaternion: q, friction: 0.8, restitution: 0.0 } );

	}

	// Back wall above the ramp lip (so you don't fly through)
	colliders.push( { kind: 'box', halfExtents: [ 0.1, 0.6, HALF ], position: [ HALF + 0.1, RAMP_H + 0.6, 0 ], friction: 0.4 } );

	return { mesh: group, colliders };

}

function buildBank() {

	// Wedge (triangular prism): flat incline from 0 at -HALF x to RAMP_H at +HALF x
	const group = new THREE.Group();
	const { concrete } = materials();

	const shape = new THREE.Shape();
	shape.moveTo( - HALF, 0 );
	shape.lineTo(   HALF, 0 );
	shape.lineTo(   HALF, RAMP_H );
	shape.lineTo( - HALF, 0 );

	const geo = new THREE.ExtrudeGeometry( shape, { depth: CELL_RAW, bevelEnabled: false } );
	geo.translate( 0, 0, - CELL_RAW / 2 );
	geo.rotateY( Math.PI / 2 );

	const mesh = new THREE.Mesh( geo, concrete );
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	group.add( mesh );

	const colliders = [];
	const angle = Math.atan2( RAMP_H, CELL_RAW );
	const hypot = Math.sqrt( RAMP_H * RAMP_H + CELL_RAW * CELL_RAW );
	colliders.push( {
		kind: 'box',
		halfExtents: [ hypot / 2, 0.1, HALF ],
		position: [ 0, RAMP_H / 2, 0 ],
		quaternion: quaternionFromEuler( 0, 0, - angle ),
		friction: 1.1
	} );
	colliders.push( {
		kind: 'box',
		halfExtents: [ 0.1, RAMP_H / 2, HALF ],
		position: [ HALF, RAMP_H / 2, 0 ],
		friction: 0.6
	} );
	colliders.push( {
		kind: 'box', halfExtents: [ HALF, 0.05, HALF ], position: [ 0, - 0.05, 0 ], friction: 1.2
	} );

	return { mesh: group, colliders };

}

function buildHalfpipe() {

	// U across the cell: two quarter walls + floor. Coping at both top lips.
	const group = new THREE.Group();
	const { concrete, concreteEdge, pool } = materials();

	const r = RAMP_H;
	const segments = 12;

	// Side-view shape
	const shape = new THREE.Shape();
	shape.moveTo( - HALF, r );
	// Left wall arc: from (-HALF, r) → (-HALF + r, 0)
	for ( let i = 0; i <= segments; i ++ ) {

		const a = Math.PI / 2 - ( i / segments ) * ( Math.PI / 2 );
		shape.lineTo( - HALF + r - r * Math.cos( a ), r - r * Math.sin( a ) );

	}
	// Floor
	shape.lineTo( HALF - r, 0 );
	// Right wall arc
	for ( let i = 0; i <= segments; i ++ ) {

		const a = - ( i / segments ) * ( Math.PI / 2 );
		shape.lineTo( HALF - r + r * Math.cos( a ), r + r * Math.sin( a ) );

	}
	// Back to start, top walls filled
	shape.lineTo( HALF, r );
	shape.lineTo( HALF, - 0.2 );
	shape.lineTo( - HALF, - 0.2 );
	shape.lineTo( - HALF, r );

	const geo = new THREE.ExtrudeGeometry( shape, { depth: CELL_RAW, bevelEnabled: false, curveSegments: segments } );
	geo.translate( 0, 0, - CELL_RAW / 2 );
	geo.rotateY( Math.PI / 2 );

	const mesh = new THREE.Mesh( geo, pool );
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	group.add( mesh );

	// Coping left + right
	const copingGeo = new THREE.CylinderGeometry( 0.06, 0.06, CELL_RAW, 10 );
	for ( const side of [ - 1, 1 ] ) {

		const coping = new THREE.Mesh( copingGeo, concreteEdge );
		coping.rotation.z = Math.PI / 2;
		coping.position.set( ( HALF - 0.04 ) * side, r + 0.01, 0 );
		group.add( coping );

	}

	const colliders = [];
	// Floor
	colliders.push( { kind: 'box', halfExtents: [ ( CELL_RAW - 2 * r ) / 2, 0.1, HALF ], position: [ 0, - 0.1, 0 ], friction: 1.2 } );

	// Arc segments for left + right walls
	for ( const side of [ - 1, 1 ] ) {

		const cx = side * ( HALF - r );
		for ( let i = 0; i < segments; i ++ ) {

			const a = side > 0 ? Math.PI + ( ( i + 0.5 ) / segments ) * ( Math.PI / 2 )
							   : - ( ( i + 0.5 ) / segments ) * ( Math.PI / 2 );
			const x = cx + r * Math.cos( a );
			const y = r + r * Math.sin( a );
			const tangentAngle = a - Math.PI / 2;

			const segLen = ( r * ( Math.PI / 2 ) ) / segments;
			colliders.push( {
				kind: 'box',
				halfExtents: [ 0.1, segLen / 2, HALF ],
				position: [ x + Math.cos( a ) * 0.1, y + Math.sin( a ) * 0.1, 0 ],
				quaternion: quaternionFromEuler( 0, 0, tangentAngle - Math.PI / 2 ),
				friction: 0.85
			} );

		}

	}

	return { mesh: group, colliders };

}

function buildRail() {

	const group = new THREE.Group();
	const { rail, concreteDark, concrete } = materials();

	// Floor
	const floor = new THREE.Mesh( new THREE.BoxGeometry( CELL_RAW, 0.4, CELL_RAW ), concrete );
	floor.position.y = - 0.2;
	floor.receiveShadow = true;
	group.add( floor );

	const railHeight = 0.55;
	const railLen = CELL_RAW - 0.4;

	const bar = new THREE.Mesh(
		new THREE.CylinderGeometry( 0.06, 0.06, railLen, 12 ),
		rail
	);
	bar.rotation.x = Math.PI / 2;
	bar.position.y = railHeight;
	bar.castShadow = true;
	group.add( bar );

	// Posts
	for ( const z of [ - railLen / 2 + 0.1, 0, railLen / 2 - 0.1 ] ) {

		const post = new THREE.Mesh( new THREE.CylinderGeometry( 0.05, 0.05, railHeight, 8 ), concreteDark );
		post.position.set( 0, railHeight / 2, z );
		post.castShadow = true;
		group.add( post );

	}

	const colliders = [
		{ kind: 'box', halfExtents: [ HALF, 0.2, HALF ], position: [ 0, - 0.2, 0 ], friction: 1.2 },
		// Rail is narrow and slightly forgiving: low friction when grinding from above
		{ kind: 'box', halfExtents: [ 0.08, 0.08, railLen / 2 ], position: [ 0, railHeight, 0 ], friction: 0.05, restitution: 0.0, grind: true },
	];

	return { mesh: group, colliders };

}

function buildLedge() {

	const group = new THREE.Group();
	const { concrete, concreteEdge } = materials();

	const floor = new THREE.Mesh( new THREE.BoxGeometry( CELL_RAW, 0.4, CELL_RAW ), concrete );
	floor.position.y = - 0.2;
	floor.receiveShadow = true;
	group.add( floor );

	const h = 0.5;
	const w = 0.8;
	const box = new THREE.Mesh( new THREE.BoxGeometry( w, h, CELL_RAW - 0.4 ), concrete );
	box.position.set( 0, h / 2, 0 );
	box.castShadow = true;
	box.receiveShadow = true;
	group.add( box );

	const cap = new THREE.Mesh( new THREE.BoxGeometry( w + 0.06, 0.04, CELL_RAW - 0.4 ), concreteEdge );
	cap.position.set( 0, h + 0.02, 0 );
	group.add( cap );

	const colliders = [
		{ kind: 'box', halfExtents: [ HALF, 0.2, HALF ], position: [ 0, - 0.2, 0 ], friction: 1.2 },
		{ kind: 'box', halfExtents: [ w / 2, h / 2, ( CELL_RAW - 0.4 ) / 2 ], position: [ 0, h / 2, 0 ], friction: 0.2, grind: true },
	];

	return { mesh: group, colliders };

}

function buildStairs() {

	const group = new THREE.Group();
	const { concrete, concreteEdge } = materials();
	const steps = 4;
	const stepH = 0.3;
	const stepD = ( CELL_RAW - 0.4 ) / steps;

	const colliders = [];

	for ( let i = 0; i < steps; i ++ ) {

		const y = stepH * ( steps - 1 - i ) + stepH / 2;
		const z = - CELL_RAW / 2 + 0.2 + stepD * ( i + 0.5 );

		const geo = new THREE.BoxGeometry( CELL_RAW - 0.6, stepH, stepD );
		const mesh = new THREE.Mesh( geo, concrete );
		mesh.position.set( 0, y, z );
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		group.add( mesh );

		const cap = new THREE.Mesh(
			new THREE.BoxGeometry( CELL_RAW - 0.6, 0.04, stepD ),
			concreteEdge
		);
		cap.position.set( 0, y + stepH / 2 + 0.02, z );
		group.add( cap );

		colliders.push( {
			kind: 'box',
			halfExtents: [ ( CELL_RAW - 0.6 ) / 2, stepH / 2, stepD / 2 ],
			position: [ 0, y, z ],
			friction: 1.0,
		} );

	}

	// Ground under the stairs' bottom
	const floor = new THREE.Mesh( new THREE.BoxGeometry( CELL_RAW, 0.4, 0.4 ), concrete );
	floor.position.set( 0, - 0.2, CELL_RAW / 2 - 0.2 );
	group.add( floor );
	colliders.push( { kind: 'box', halfExtents: [ HALF, 0.2, 0.2 ], position: [ 0, - 0.2, CELL_RAW / 2 - 0.2 ], friction: 1.2 } );

	return { mesh: group, colliders };

}

function buildFunbox() {

	const group = new THREE.Group();
	const { concrete, concreteEdge } = materials();

	// Flat top box 2 cells wide visually, but we stay inside 1 cell
	const topH = 1.1;
	const topW = 2.4;
	const topD = CELL_RAW - 0.8;

	const top = new THREE.Mesh( new THREE.BoxGeometry( topW, topH, topD ), concrete );
	top.position.y = topH / 2;
	top.castShadow = true;
	top.receiveShadow = true;
	group.add( top );

	const cap = new THREE.Mesh(
		new THREE.BoxGeometry( topW + 0.06, 0.04, topD + 0.06 ),
		concreteEdge
	);
	cap.position.y = topH + 0.02;
	group.add( cap );

	// Two triangular banks (east + west)
	const bankShape = new THREE.Shape();
	bankShape.moveTo( 0, 0 );
	bankShape.lineTo( ( CELL_RAW - topW ) / 2, 0 );
	bankShape.lineTo( 0, topH );
	bankShape.lineTo( 0, 0 );

	const bankGeo = new THREE.ExtrudeGeometry( bankShape, { depth: topD, bevelEnabled: false } );
	bankGeo.translate( 0, 0, - topD / 2 );

	const bankE = new THREE.Mesh( bankGeo, concrete );
	bankE.position.set( topW / 2, 0, 0 );
	bankE.castShadow = true;
	bankE.receiveShadow = true;
	group.add( bankE );

	const bankW = bankE.clone();
	bankW.scale.x = - 1;
	bankW.position.x = - topW / 2;
	group.add( bankW );

	// Floor runners on open sides
	const runner = new THREE.Mesh( new THREE.BoxGeometry( CELL_RAW, 0.4, ( CELL_RAW - topD ) / 2 ), concrete );
	runner.position.set( 0, - 0.2, - ( CELL_RAW + topD ) / 4 );
	group.add( runner );
	const runner2 = runner.clone();
	runner2.position.z = ( CELL_RAW + topD ) / 4;
	group.add( runner2 );

	const colliders = [];
	// Top surface
	colliders.push( { kind: 'box', halfExtents: [ topW / 2, topH / 2, topD / 2 ], position: [ 0, topH / 2, 0 ], friction: 1.0 } );

	// Banks — inclined planes
	const rampLen = Math.sqrt( Math.pow( ( CELL_RAW - topW ) / 2, 2 ) + topH * topH );
	const rampAngle = Math.atan2( topH, ( CELL_RAW - topW ) / 2 );
	for ( const side of [ - 1, 1 ] ) {

		colliders.push( {
			kind: 'box',
			halfExtents: [ rampLen / 2, 0.1, topD / 2 ],
			position: [ side * ( topW / 2 + ( CELL_RAW - topW ) / 4 ), topH / 2, 0 ],
			quaternion: quaternionFromEuler( 0, 0, side * rampAngle ),
			friction: 0.9
		} );

	}

	// Thin runners along open sides so we don't fall off the world
	colliders.push( { kind: 'box', halfExtents: [ HALF, 0.2, ( CELL_RAW - topD ) / 4 ], position: [ 0, - 0.2, - ( CELL_RAW + topD ) / 4 ], friction: 1.2 } );
	colliders.push( { kind: 'box', halfExtents: [ HALF, 0.2, ( CELL_RAW - topD ) / 4 ], position: [ 0, - 0.2,   ( CELL_RAW + topD ) / 4 ], friction: 1.2 } );

	return { mesh: group, colliders };

}

function buildPyramid() {

	const group = new THREE.Group();
	const { concrete, concreteEdge } = materials();

	const base = HALF * 2;
	const h = RAMP_H;

	// Pyramid built from 4 tilted triangles
	const geo = new THREE.BufferGeometry();
	const verts = new Float32Array( [
		- HALF, 0, - HALF,     HALF, 0, - HALF,   0, h, 0,
		  HALF, 0, - HALF,     HALF, 0,   HALF,   0, h, 0,
		  HALF, 0,   HALF,   - HALF, 0,   HALF,   0, h, 0,
		- HALF, 0,   HALF,   - HALF, 0, - HALF,   0, h, 0,
	] );
	geo.setAttribute( 'position', new THREE.BufferAttribute( verts, 3 ) );
	geo.computeVertexNormals();

	const mesh = new THREE.Mesh( geo, concrete );
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	group.add( mesh );

	const tip = new THREE.Mesh(
		new THREE.BoxGeometry( 0.2, 0.06, 0.2 ),
		concreteEdge
	);
	tip.position.y = h;
	group.add( tip );

	const floor = new THREE.Mesh( new THREE.BoxGeometry( CELL_RAW, 0.4, CELL_RAW ), concrete );
	floor.position.y = - 0.2;
	floor.receiveShadow = true;
	group.add( floor );

	const colliders = [];
	colliders.push( { kind: 'box', halfExtents: [ HALF, 0.2, HALF ], position: [ 0, - 0.2, 0 ], friction: 1.2 } );

	const faceAngle = Math.atan2( h, HALF );
	const faceHypot = Math.sqrt( h * h + HALF * HALF );

	// 4 inclined faces
	const faces = [
		{ axis: 'x', sign:   1 },
		{ axis: 'x', sign: - 1 },
		{ axis: 'z', sign:   1 },
		{ axis: 'z', sign: - 1 },
	];
	for ( const { axis, sign } of faces ) {

		const euler = axis === 'x'
			? [ 0, 0, - sign * faceAngle ]
			: [ sign * faceAngle, 0, 0 ];

		const pos = axis === 'x'
			? [ sign * HALF / 2, h / 2, 0 ]
			: [ 0, h / 2, sign * HALF / 2 ];

		colliders.push( {
			kind: 'box',
			halfExtents: [ axis === 'x' ? faceHypot / 2 : HALF, 0.1, axis === 'x' ? HALF : faceHypot / 2 ],
			position: pos,
			quaternion: quaternionFromEuler( euler[ 0 ], euler[ 1 ], euler[ 2 ] ),
			friction: 0.95
		} );

	}

	return { mesh: group, colliders };

}

const BUILDERS = {
	flat:     buildFlat,
	spawn:    buildSpawn,
	quarter:  buildQuarter,
	bank:     buildBank,
	halfpipe: buildHalfpipe,
	rail:     buildRail,
	ledge:    buildLedge,
	stairs:   buildStairs,
	funbox:   buildFunbox,
	pyramid:  buildPyramid,
};

// ─── Build whole park ────────────────────────────────────────

export function buildPark( scene, cells, { groundColor = 0x7ba45a, scatter = KENNEY_SCATTER } = {} ) {

	const used = cells || DEFAULT_PARK;

	const parkGroup = new THREE.Group();
	parkGroup.name = 'park';
	scene.add( parkGroup );

	const { concrete, concreteDark, concreteEdge } = materials();

	const bounds = computeParkBounds( used, scatter );
	const groundSize = Math.max( bounds.halfWidth, bounds.halfDepth ) * 2 + 30;

	// Grass backdrop (extends out past the park)
	const grass = new THREE.Mesh(
		new THREE.PlaneGeometry( groundSize, groundSize ),
		new THREE.MeshStandardMaterial( { color: groundColor, roughness: 1.0 } )
	);
	grass.rotation.x = - Math.PI / 2;
	grass.position.set( bounds.centerX, - 0.05, bounds.centerZ );
	grass.receiveShadow = true;
	parkGroup.add( grass );

	// Flat concrete foundation — the skater never sees a gap again
	const padX = 1.5, padZ = 1.5;
	const floorW = bounds.halfWidth  * 2 + padX * 2;
	const floorD = bounds.halfDepth  * 2 + padZ * 2;
	const floorCx = bounds.centerX;
	const floorCz = bounds.centerZ;

	const slab = new THREE.Mesh(
		new THREE.BoxGeometry( floorW, 0.4, floorD ),
		concrete
	);
	slab.position.set( floorCx, - 0.2, floorCz );
	slab.receiveShadow = true;
	parkGroup.add( slab );

	// Painted edging so the border is readable from far away
	const edgeStrip = new THREE.Mesh(
		new THREE.BoxGeometry( floorW + 0.06, 0.04, floorD + 0.06 ),
		concreteEdge
	);
	edgeStrip.position.set( floorCx, 0.02, floorCz );
	parkGroup.add( edgeStrip );

	// Border walls around the perimeter — like the racing-kit walls
	const borderColliders = [];
	const wallH = 1.2;
	const wallThick = 0.3;
	const wallY = wallH / 2;
	const wallMat = concreteDark;

	const extX = floorW / 2 + wallThick / 2;
	const extZ = floorD / 2 + wallThick / 2;

	const wallSpecs = [
		// [ halfExtents, position ]
		[ [ extX + wallThick / 2, wallH / 2, wallThick / 2 ], [ floorCx, wallY, floorCz - extZ ] ],        // North
		[ [ extX + wallThick / 2, wallH / 2, wallThick / 2 ], [ floorCx, wallY, floorCz + extZ ] ],        // South
		[ [ wallThick / 2, wallH / 2, extZ + wallThick / 2 ], [ floorCx - extX, wallY, floorCz ] ],        // West
		[ [ wallThick / 2, wallH / 2, extZ + wallThick / 2 ], [ floorCx + extX, wallY, floorCz ] ],        // East
	];

	for ( const [ he, pos ] of wallSpecs ) {

		const wallMesh = new THREE.Mesh(
			new THREE.BoxGeometry( he[ 0 ] * 2, he[ 1 ] * 2, he[ 2 ] * 2 ),
			wallMat
		);
		wallMesh.position.set( pos[ 0 ], pos[ 1 ], pos[ 2 ] );
		wallMesh.castShadow = true;
		wallMesh.receiveShadow = true;
		parkGroup.add( wallMesh );

		// Yellow safety cap so the border reads clearly
		const cap = new THREE.Mesh(
			new THREE.BoxGeometry( he[ 0 ] * 2, 0.05, he[ 2 ] * 2 ),
			new THREE.MeshStandardMaterial( { color: 0xf4c24e, roughness: 0.6 } )
		);
		cap.position.set( pos[ 0 ], wallH + 0.025, pos[ 2 ] );
		parkGroup.add( cap );

		borderColliders.push( { halfExtents: he, position: pos, friction: 0.0, restitution: 0.1 } );

	}

	const piecesOut = [];

	for ( const [ gx, gz, type, orient ] of used ) {

		const built = placePiece( type, gx, gz, orient );
		if ( ! built ) continue;
		parkGroup.add( built.group );
		piecesOut.push( built );

	}

	parkGroup.traverse( ( child ) => {

		if ( child.isMesh ) {

			child.castShadow = true;
			child.receiveShadow = true;

		}

	} );

	return {
		group: parkGroup,
		pieces: piecesOut,
		bounds,
		groundSize,
		borderColliders,
		floorCollider: { halfExtents: [ floorW / 2, 0.2, floorD / 2 ], position: [ floorCx, - 0.2, floorCz ], friction: 1.2 },
	};

}

export async function loadObjectAssets( park, scatter = KENNEY_SCATTER ) {

	// Warm the loader cache so pieces below instantiate in parallel.
	await preloadKenneyPack( Array.from( new Set( scatter.map( ( s ) => s.asset ) ) ) );

	const loaded = [];

	await Promise.all( scatter.map( async ( spec ) => {

		try {

			const { group: model, size, innerMatrix } = await instantiateKenney( spec.asset, {
				targetFootprint: spec.footprint,
				alignLongestAxisTo: spec.alignLongestAxisTo || null,
				flatShading: true,
			} );

			// Prefer colliders derived from the OBJ mesh: they hug the actual
			// geometry (rail tops, ramp slopes, step faces) instead of approximating
			// a bounding box. Fall back to the legacy hand-written recipe if the
			// OBJ parse fails or produces no useful surfaces.
			let colliders = [];
			try {

				const gen = await generateCollidersFor( spec.asset );
				if ( gen.colliders.length > 0 ) {

					colliders = gen.colliders.map( ( c ) => transformCollider( c, innerMatrix ) );

				}

			} catch ( err ) {

				console.warn( `OBJ collider generation failed for ${ spec.asset } — falling back to legacy recipe`, err );

			}

			if ( colliders.length === 0 ) {

				colliders = cloneColliders( spec.build ? spec.build( { x: size.x, y: size.y, z: size.z } ) : [] );

			}

			const wrapper = new THREE.Group();
			wrapper.name = spec.id;
			wrapper.position.set( spec.position[ 0 ], spec.position[ 1 ], spec.position[ 2 ] );
			wrapper.rotation.y = spec.yaw || 0;
			wrapper.add( model );

			park.group.add( wrapper );

			const piece = {
				group: wrapper,
				colliders,
				angle: spec.yaw || 0,
				type: spec.id,
				gx: 0,
				gz: 0,
				orient: 0,
			};

			park.pieces.push( piece );
			loaded.push( piece );

		} catch ( err ) {

			console.warn( `Could not load Kenney asset: ${ spec.asset }`, err );

		}

	} ) );

	return loaded;

}

export function placePiece( type, gx, gz, orient ) {

	const builder = BUILDERS[ type ];
	if ( ! builder ) return null;

	const { mesh, colliders } = builder();

	const angle = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] || 0 );
	const group = new THREE.Group();
	group.add( mesh );
	mesh.rotation.y = angle;

	const x = ( gx + 0.5 ) * CELL_RAW;
	const z = ( gz + 0.5 ) * CELL_RAW;
	group.position.set( x, 0, z );

	return { group, colliders, angle, type, gx, gz, orient };

}

// ─── Spawn + bounds ──────────────────────────────────────────

export function computeSpawnPosition( cells, mapSpawn = null ) {

	// Server-provided map spawn wins (custom parks + generated maps set this).
	if ( mapSpawn && Number.isFinite( mapSpawn.x ) && Number.isFinite( mapSpawn.z ) ) {

		return { position: [ mapSpawn.x, 0.8, mapSpawn.z ], angle: Number( mapSpawn.yaw ) || 0 };

	}

	const used = cells || DEFAULT_PARK;

	for ( const [ gx, gz, type, orient ] of used ) {

		if ( type === 'spawn' ) {

			const x = ( gx + 0.5 ) * CELL_RAW * GRID_SCALE;
			const z = ( gz + 0.5 ) * CELL_RAW * GRID_SCALE;
			const angle = THREE.MathUtils.degToRad( ORIENT_DEG[ orient ] || 0 );
			return { position: [ x, 0.8, z ], angle };

		}

	}

	// Fallback — first cell center
	const first = used[ 0 ];
	if ( ! first ) return { position: [ 0, 0.8, 0 ], angle: 0 };
	const x = ( first[ 0 ] + 0.5 ) * CELL_RAW * GRID_SCALE;
	const z = ( first[ 1 ] + 0.5 ) * CELL_RAW * GRID_SCALE;
	return { position: [ x, 0.8, z ], angle: 0 };

}

export function computeParkBounds( cells, scatter = KENNEY_SCATTER ) {

	const used = cells || DEFAULT_PARK;
	if ( used.length === 0 && scatter.length === 0 ) return { centerX: 0, centerZ: 0, halfWidth: 20, halfDepth: 20 };

	let minX = Infinity, maxX = - Infinity;
	let minZ = Infinity, maxZ = - Infinity;

	for ( const [ gx, gz ] of used ) {

		minX = Math.min( minX, gx );
		maxX = Math.max( maxX, gx );
		minZ = Math.min( minZ, gz );
		maxZ = Math.max( maxZ, gz );

	}

	const S = CELL_RAW * GRID_SCALE;

	for ( const spec of scatter ) {

		const footprint = spec.footprint ?? 8;
		minX = Math.min( minX, Math.floor( ( spec.position[ 0 ] - footprint ) / S ) );
		maxX = Math.max( maxX, Math.ceil(  ( spec.position[ 0 ] + footprint ) / S ) );
		minZ = Math.min( minZ, Math.floor( ( spec.position[ 2 ] - footprint ) / S ) );
		maxZ = Math.max( maxZ, Math.ceil(  ( spec.position[ 2 ] + footprint ) / S ) );

	}

	const centerX = ( minX + maxX + 1 ) / 2 * S;
	const centerZ = ( minZ + maxZ + 1 ) / 2 * S;
	const halfWidth = ( maxX - minX + 1 ) / 2 * S + S;
	const halfDepth = ( maxZ - minZ + 1 ) / 2 * S + S;

	return { centerX, centerZ, halfWidth, halfDepth };

}

// ─── URL codec (shareable parks) ─────────────────────────────

export function encodeCells( cells ) {

	const bytes = new Uint8Array( cells.length * 3 );
	for ( let i = 0; i < cells.length; i ++ ) {

		const [ gx, gz, type, orient ] = cells[ i ];
		const ti = TYPE_INDEX[ type ] ?? 0;
		const oi = ( orient | 0 ) & 0x03;

		bytes[ i * 3 ]     = gx + 128;
		bytes[ i * 3 + 1 ] = gz + 128;
		bytes[ i * 3 + 2 ] = ( ti << 2 ) | oi;

	}
	return bytesToBase64url( bytes );

}

export function decodeCells( str ) {

	const bytes = base64urlToBytes( str );
	const cells = [];
	for ( let i = 0; i + 2 < bytes.length; i += 3 ) {

		const gx = bytes[ i ] - 128;
		const gz = bytes[ i + 1 ] - 128;
		const packed = bytes[ i + 2 ];
		const ti = ( packed >> 2 ) & 0x3f;
		const oi = packed & 0x03;
		cells.push( [ gx, gz, PIECE_TYPES[ ti ] || 'flat', oi ] );

	}
	return cells;

}

function bytesToBase64url( bytes ) {

	let binary = '';
	for ( let i = 0; i < bytes.length; i ++ ) binary += String.fromCharCode( bytes[ i ] );
	return btoa( binary ).replace( /\+/g, '-' ).replace( /\//g, '_' ).replace( /=+$/, '' );

}

function base64urlToBytes( str ) {

	const base64 = str.replace( /-/g, '+' ).replace( /_/g, '/' );
	const binary = atob( base64 );
	const bytes = new Uint8Array( binary.length );
	for ( let i = 0; i < binary.length; i ++ ) bytes[ i ] = binary.charCodeAt( i );
	return bytes;

}
