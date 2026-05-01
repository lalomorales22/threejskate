// Deterministic seeded park generator.
//
// Takes a seed (string or number) and emits a full map definition the client
// can render without any additional negotiation. The shape is intentionally
// trivial so the same generator can power random per-round maps and also be
// serialized by the editor.
//
//   map = { seed, name, pieces: [ { asset, x, z, yaw } ... ], spawn: { x, z, yaw } }
//
// `asset` is a Kenney prefab key that matches KENNEY_PREFABS on the client.

// Tunables — these control how dense / varied a random park feels.
const ARENA_HALF = 30;             // pieces placed within ±ARENA_HALF around spawn
const SPAWN_RADIUS = 5;            // keep a clear area around spawn
const MIN_SEPARATION = 6.5;        // pieces can't crowd each other
const MAX_ATTEMPTS_PER_PIECE = 20;

// Piece palette with relative weights + how many copies to attempt per map.
// Rails dominate because grinds are the skater's main expression; ramps and
// boxes fill in the movement texture.
const PIECE_WEIGHTS = [
	[ 'railLow',          { weight: 18, count: [ 2, 4 ] } ],
	[ 'railHigh',         { weight: 12, count: [ 1, 3 ] } ],
	[ 'railSlope',        { weight: 8,  count: [ 0, 2 ] } ],
	[ 'railCurve',        { weight: 6,  count: [ 0, 2 ] } ],
	[ 'halfPipe',         { weight: 10, count: [ 1, 2 ] } ],
	[ 'bowlSide',         { weight: 4,  count: [ 0, 2 ] } ],
	[ 'bowlCornerInner',  { weight: 3,  count: [ 0, 1 ] } ],
	[ 'bowlCornerOuter',  { weight: 3,  count: [ 0, 1 ] } ],
	[ 'steps',            { weight: 8,  count: [ 1, 2 ] } ],
	[ 'obstacleBox',      { weight: 10, count: [ 1, 3 ] } ],
	[ 'obstacleMiddle',   { weight: 8,  count: [ 1, 3 ] } ],
	[ 'obstacleEnd',      { weight: 6,  count: [ 0, 2 ] } ],
	[ 'pallet',           { weight: 6,  count: [ 0, 3 ] } ],
	[ 'structurePlatform',{ weight: 5,  count: [ 0, 2 ] } ],
	[ 'structureWood',    { weight: 5,  count: [ 0, 2 ] } ],
];

// A simple seedable PRNG (mulberry32). Good enough for deterministic layouts
// — cryptographic quality is not needed here.
function mulberry32( seed ) {

	let t = seed >>> 0;
	return function () {

		t = ( t + 0x6D2B79F5 ) >>> 0;
		let r = Math.imul( t ^ ( t >>> 15 ), 1 | t );
		r = ( r + Math.imul( r ^ ( r >>> 7 ), 61 | r ) ) ^ r;
		return ( ( r ^ ( r >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

// Hash a string seed into a 32-bit int (FNV-1a).
function hashSeed( seed ) {

	if ( typeof seed === 'number' ) return seed >>> 0;
	let h = 2166136261 >>> 0;
	const str = String( seed );
	for ( let i = 0; i < str.length; i ++ ) {
		h ^= str.charCodeAt( i );
		h = Math.imul( h, 16777619 );
	}
	return h >>> 0;

}

export function generateMap( seed, { name = null } = {} ) {

	const rng = mulberry32( hashSeed( seed ) );

	const pieces = [];

	for ( const [ asset, cfg ] of PIECE_WEIGHTS ) {

		const [ minC, maxC ] = cfg.count;
		const count = minC + Math.floor( rng() * ( maxC - minC + 1 ) );

		for ( let i = 0; i < count; i ++ ) {

			const placed = placeWithRetries( pieces, rng );
			if ( placed ) pieces.push( { asset, x: placed.x, z: placed.z, yaw: placed.yaw } );

		}

	}

	return {
		seed: String( seed ),
		name: name || `park #${ seed }`,
		pieces,
		spawn: { x: 0, z: 0, yaw: 0 },
	};

}

function placeWithRetries( existing, rng ) {

	for ( let attempt = 0; attempt < MAX_ATTEMPTS_PER_PIECE; attempt ++ ) {

		const x = ( rng() * 2 - 1 ) * ARENA_HALF;
		const z = ( rng() * 2 - 1 ) * ARENA_HALF;

		if ( Math.hypot( x, z ) < SPAWN_RADIUS ) continue;
		if ( tooClose( existing, x, z ) ) continue;

		// Snap yaw to 8 cardinal + diagonal angles so pieces read as
		// intentional rather than haphazardly tilted.
		const yaw = Math.floor( rng() * 8 ) * Math.PI / 4;
		return { x, z, yaw };

	}
	return null;

}

function tooClose( pieces, x, z ) {

	for ( const p of pieces ) {

		if ( Math.hypot( p.x - x, p.z - z ) < MIN_SEPARATION ) return true;

	}
	return false;

}

// Sanity-check a user-submitted map payload from the editor. Unknown asset
// names, absurd coordinates, or malformed entries are dropped on the floor.
// Returns a clean map object on success, null on total failure.
export function sanitizeUserMap( raw, validAssetNames ) {

	if ( ! raw || typeof raw !== 'object' ) return null;
	const pieces = Array.isArray( raw.pieces ) ? raw.pieces : [];

	const clean = [];
	for ( const p of pieces ) {

		if ( ! p || ! validAssetNames.has( p.asset ) ) continue;
		const x = Number( p.x );
		const z = Number( p.z );
		const yaw = Number( p.yaw || 0 );
		if ( ! isFinite( x ) || ! isFinite( z ) || ! isFinite( yaw ) ) continue;
		if ( Math.abs( x ) > ARENA_HALF + 10 || Math.abs( z ) > ARENA_HALF + 10 ) continue;
		clean.push( { asset: p.asset, x, z, yaw } );
		if ( clean.length >= 80 ) break;   // hard cap to prevent abuse

	}

	if ( clean.length === 0 ) return null;

	return {
		seed: null,
		name: String( raw.name || 'untitled park' ).slice( 0, 40 ),
		pieces: clean,
		spawn: { x: 0, z: 0, yaw: 0 },
	};

}
