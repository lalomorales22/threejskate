import * as THREE from 'three';

// Derive gameplay colliders directly from Kenney's OBJ meshes.
//
// The OBJ files live alongside the GLBs (same geometry, just text-encoded) so
// we can read real vertex positions in the browser, cluster coplanar
// triangles, and emit thin slab colliders aligned to actual surfaces — much
// more accurate than the hand-written bbox approximations in Park.js.
//
// Output colliders are in OBJ-native coordinates. Park.js transforms them
// through the GLB's scaled+rotated+centered inner matrix so they line up
// exactly with the visible mesh.

const OBJ_BASE = 'mini-skate/Models/OBJ%20format/';
const cache = new Map();

// Tunables (all in OBJ-native units — 1 unit ≈ 1 m in the Kenney pack).
const NORMAL_COS_TOL = 0.98;   // triangles are coplanar if normals within ~11°
const PLANE_DIST_TOL = 0.015;  // ...and ≤ 1.5 cm apart on the shared plane
const COLLIDER_THICK = 0.025;  // slab half-thickness beneath each surface
const RAIL_MAX_MIN_HALF = 0.06;  // a surface ≤ 12 cm wide is a rail candidate
const RAIL_MIN_MAX_HALF = 0.15;  // ...but it has to be long (≥ 30 cm)
const LEDGE_MIN_MAX_HALF = 0.22; // elevated flat ≥ 44 cm wide = grindable ledge

export async function loadObj( name ) {

	if ( ! cache.has( name ) ) {

		const p = fetch( OBJ_BASE + name + '.obj' ).then( ( r ) => {

			if ( ! r.ok ) throw new Error( `OBJ fetch ${ name }: ${ r.status }` );
			return r.text();

		} ).then( parseObj );
		cache.set( name, p );

	}
	return cache.get( name );

}

export function parseObj( text ) {

	const verts = [];
	const tris = [];
	const lines = text.split( '\n' );

	for ( const line of lines ) {

		const trimmed = line.trim();
		if ( trimmed.length === 0 || trimmed[ 0 ] === '#' ) continue;
		const parts = trimmed.split( /\s+/ );

		if ( parts[ 0 ] === 'v' ) {

			verts.push( new THREE.Vector3(
				parseFloat( parts[ 1 ] ),
				parseFloat( parts[ 2 ] ),
				parseFloat( parts[ 3 ] ),
			) );

		} else if ( parts[ 0 ] === 'f' ) {

			// Face indices are 1-based. Any of: "v", "v/vt", "v/vt/vn", "v//vn".
			const idx = [];
			for ( let i = 1; i < parts.length; i ++ ) {

				const token = parts[ i ].split( '/' )[ 0 ];
				const n = parseInt( token, 10 );
				if ( Number.isFinite( n ) ) idx.push( n - 1 );

			}
			// Fan-triangulate quads / n-gons
			for ( let i = 1; i + 1 < idx.length; i ++ ) {

				const a = idx[ 0 ], b = idx[ i ], c = idx[ i + 1 ];
				const va = verts[ a ], vb = verts[ b ], vc = verts[ c ];
				if ( ! va || ! vb || ! vc ) continue;
				const e1 = new THREE.Vector3().subVectors( vb, va );
				const e2 = new THREE.Vector3().subVectors( vc, va );
				const cross = new THREE.Vector3().crossVectors( e1, e2 );
				const len = cross.length();
				if ( len < 1e-9 ) continue;
				const normal = cross.divideScalar( len );
				const area = len * 0.5;
				const centroid = new THREE.Vector3().add( va ).add( vb ).add( vc ).divideScalar( 3 );
				tris.push( { a, b, c, normal, centroid, area } );

			}

		}

	}

	const bbox = new THREE.Box3();
	for ( const v of verts ) bbox.expandByPoint( v );
	return { verts, tris, bbox };

}

// ─── Clustering ────────────────────────────────────────────────
// Group triangles that share a plane (same normal + same offset along normal).
function clusterTris( tris ) {

	const clusters = [];
	for ( const t of tris ) {

		let best = null;
		for ( const c of clusters ) {

			if ( c.normal.dot( t.normal ) < NORMAL_COS_TOL ) continue;
			const offset = t.centroid.dot( c.normal ) - c.planeD;
			if ( Math.abs( offset ) > PLANE_DIST_TOL ) continue;
			best = c;
			break;

		}
		if ( best ) {

			// Area-weighted running average for normal and plane offset
			const newArea = best.area + t.area;
			best.normal.multiplyScalar( best.area ).addScaledVector( t.normal, t.area ).divideScalar( newArea ).normalize();
			best.planeD = ( best.planeD * best.area + t.centroid.dot( t.normal ) * t.area ) / newArea;
			best.area = newArea;
			best.tris.push( t );

		} else {

			clusters.push( {
				normal: t.normal.clone(),
				planeD: t.centroid.dot( t.normal ),
				area: t.area,
				tris: [ t ],
			} );

		}

	}
	return clusters;

}

// Split a cluster into spatially-disconnected components (so a table top and a
// shelf at the same height don't merge into one giant collider).
function splitConnected( cluster ) {

	const tris = cluster.tris;
	if ( tris.length <= 1 ) return [ cluster ];

	const vertToTris = new Map();
	tris.forEach( ( t, i ) => {

		for ( const v of [ t.a, t.b, t.c ] ) {

			if ( ! vertToTris.has( v ) ) vertToTris.set( v, [] );
			vertToTris.get( v ).push( i );

		}

	} );

	const visited = new Array( tris.length ).fill( false );
	const out = [];

	for ( let start = 0; start < tris.length; start ++ ) {

		if ( visited[ start ] ) continue;
		const group = [];
		const stack = [ start ];
		while ( stack.length ) {

			const i = stack.pop();
			if ( visited[ i ] ) continue;
			visited[ i ] = true;
			group.push( tris[ i ] );
			for ( const v of [ tris[ i ].a, tris[ i ].b, tris[ i ].c ] ) {

				const adj = vertToTris.get( v ) || [];
				for ( const j of adj ) if ( ! visited[ j ] ) stack.push( j );

			}

		}
		out.push( { ...cluster, tris: group, area: group.reduce( ( s, t ) => s + t.area, 0 ) } );

	}
	return out;

}

// ─── OBB per cluster ──────────────────────────────────────────
// Projects cluster vertices onto the plane and returns an axis-aligned
// rectangle in that plane (using a reference axis projected into the plane
// for consistent orientation).
function clusterOBB( cluster, verts ) {

	const normal = cluster.normal;
	const seen = new Set();
	const pts = [];
	for ( const t of cluster.tris ) {

		for ( const vi of [ t.a, t.b, t.c ] ) {

			if ( seen.has( vi ) ) continue;
			seen.add( vi );
			pts.push( verts[ vi ] );

		}

	}
	if ( pts.length < 3 ) return null;

	// Reference in-plane axis: world-X unless the normal is nearly along X.
	const ref = Math.abs( normal.x ) < 0.85 ? new THREE.Vector3( 1, 0, 0 ) : new THREE.Vector3( 0, 0, 1 );
	const axisU = ref.clone().addScaledVector( normal, - ref.dot( normal ) );
	if ( axisU.lengthSq() < 1e-8 ) return null;
	axisU.normalize();
	const axisV = new THREE.Vector3().crossVectors( normal, axisU ).normalize();

	let minU = Infinity, maxU = - Infinity, minV = Infinity, maxV = - Infinity, sumN = 0;
	for ( const p of pts ) {

		const u = p.dot( axisU );
		const v = p.dot( axisV );
		sumN += p.dot( normal );
		if ( u < minU ) minU = u;
		if ( u > maxU ) maxU = u;
		if ( v < minV ) minV = v;
		if ( v > maxV ) maxV = v;

	}

	const halfU = ( maxU - minU ) / 2;
	const halfV = ( maxV - minV ) / 2;
	const cU = ( maxU + minU ) / 2;
	const cV = ( maxV + minV ) / 2;
	const avgN = sumN / pts.length;

	const center = new THREE.Vector3()
		.addScaledVector( axisU, cU )
		.addScaledVector( axisV, cV )
		.addScaledVector( normal, avgN );

	return { center, axisU, axisV, normal, halfU, halfV };

}

// ─── Classification ───────────────────────────────────────────
function classify( obb, bbox ) {

	const up = obb.normal.y;
	const minHalf = Math.min( obb.halfU, obb.halfV );
	const maxHalf = Math.max( obb.halfU, obb.halfV );
	const bboxH = Math.max( 0.01, bbox.max.y - bbox.min.y );
	const heightFrac = ( obb.center.y - bbox.min.y ) / bboxH;

	// Skip faces pointing down — we don't need colliders underneath pieces.
	if ( up < - 0.25 ) return null;
	if ( minHalf < 1e-3 || maxHalf < 1e-3 ) return null;

	// Thin elevated strip, regardless of whether it's level or tilted → rail.
	if ( up > 0.55 && minHalf < RAIL_MAX_MIN_HALF && maxHalf > RAIL_MIN_MAX_HALF && heightFrac > 0.45 ) {

		return { friction: 0.04, grind: true, role: 'rail' };

	}

	if ( up > 0.92 ) {

		// Level top face.
		if ( heightFrac > 0.35 && maxHalf > LEDGE_MIN_MAX_HALF ) {

			return { friction: 0.7, grind: 'slide', role: 'ledge' };

		}
		return { friction: 1.15, role: 'floor' };

	}

	if ( up > 0.25 ) {

		return { friction: 0.9, role: 'ramp' };

	}

	// Near-vertical: wall / side of an obstacle.
	return { friction: 0.6, role: 'wall' };

}

function obbToCollider( obb, role, bbox ) {

	// Slab stays thin so nearby surfaces don't become invisible walls. The
	// skater can approach a rail / ramp without smacking into a thick box face.
	const halfT = COLLIDER_THICK;

	// Extend ride-on surfaces (ramps, floors, ledges) past their actual edges
	// in-plane. This does two jobs:
	//  1. Adjacent ramp segments overlap at shared edges — no gap to fall into.
	//  2. The ramp's down-slope edge extrapolates past its real base. Because
	//     extending along the ramp plane in the down-slope direction also
	//     drops Y, the extended overhang dips below ground level — so the
	//     skater transitioning from ground onto the ramp rolls onto the TOP
	//     face instead of slamming into the leading edge like a curb.
	// Rails/walls aren't extended: they'd grow into unintended collision space.
	const RIDE_LIP = 0.06;  // OBJ-native units (≈ +50 cm at the half-pipe's 8.5× scale)
	const isRide = role.role === 'ramp' || role.role === 'floor' || role.role === 'ledge';
	const halfU = obb.halfU + ( isRide ? RIDE_LIP : 0 );
	const halfV = obb.halfV + ( isRide ? RIDE_LIP : 0 );

	// Position so the TOP face (along +local-Y, which maps to +normal in world)
	// is flush with the surface.
	const pos = obb.center.clone().addScaledVector( obb.normal, - halfT );

	// Build a basis where local Y is the surface normal, local X is axisU,
	// local Z is axisV. That way halfExtents[1] is the thickness along normal.
	const m = new THREE.Matrix4().makeBasis( obb.axisU, obb.normal, obb.axisV );
	const q = new THREE.Quaternion().setFromRotationMatrix( m );

	return {
		kind: 'box',
		halfExtents: [ halfU, halfT, halfV ],
		position: [ pos.x, pos.y, pos.z ],
		quaternion: [ q.x, q.y, q.z, q.w ],
		friction: role.friction,
		restitution: 0.0,
		grind: role.grind,
		role: role.role,
	};

}

// ─── Public entry point ──────────────────────────────────────
export async function generateCollidersFor( name ) {

	const { verts, tris, bbox } = await loadObj( name );
	const clusters = clusterTris( tris );

	const colliders = [];
	for ( const c of clusters ) {

		for ( const sub of splitConnected( c ) ) {

			const obb = clusterOBB( sub, verts );
			if ( ! obb ) continue;
			// Skip micro-surfaces (< 1 cm²) that'd pollute the collider set.
			if ( obb.halfU * obb.halfV < 1e-4 ) continue;
			const role = classify( obb, bbox );
			if ( ! role ) continue;
			colliders.push( obbToCollider( obb, role, bbox ) );

		}

	}

	return { colliders, bbox };

}

// Transform a collider from OBJ-native space through the inner-group matrix
// produced by Assets.instantiateKenney (uniform scale + optional Y rotation +
// centering). Scale is assumed uniform (that's what instantiateKenney does).
const _tmpPos = new THREE.Vector3();
const _tmpT = new THREE.Vector3();
const _tmpQ = new THREE.Quaternion();
const _tmpS = new THREE.Vector3();

export function transformCollider( c, innerMatrix ) {

	innerMatrix.decompose( _tmpT, _tmpQ, _tmpS );

	_tmpPos.set( c.position[ 0 ], c.position[ 1 ], c.position[ 2 ] );
	_tmpPos.multiply( _tmpS ).applyQuaternion( _tmpQ ).add( _tmpT );

	const localQ = new THREE.Quaternion( c.quaternion[ 0 ], c.quaternion[ 1 ], c.quaternion[ 2 ], c.quaternion[ 3 ] );
	const worldQ = new THREE.Quaternion().multiplyQuaternions( _tmpQ, localQ );

	const sAvg = ( _tmpS.x + _tmpS.y + _tmpS.z ) / 3;

	return {
		...c,
		halfExtents: [ c.halfExtents[ 0 ] * sAvg, c.halfExtents[ 1 ] * sAvg, c.halfExtents[ 2 ] * sAvg ],
		position: [ _tmpPos.x, _tmpPos.y, _tmpPos.z ],
		quaternion: [ worldQ.x, worldQ.y, worldQ.z, worldQ.w ],
	};

}
