import * as THREE from 'three';
import { rigidBody, box, sphere, MotionType, MotionQuality } from 'crashcat';

const _tmpQuat = new THREE.Quaternion();
const _rotQuat = new THREE.Quaternion();
const _combinedQuat = new THREE.Quaternion();
const _vec = new THREE.Vector3();
const _up = new THREE.Vector3( 0, 1, 0 );

// Color-coded wireframes so toggling the debug overlay immediately shows *what*
// each collider is: rails (yellow), slide ledges (orange), ramps (cyan), flat
// floors (green), walls (white).
const _debugMats = {
	rail:  new THREE.MeshBasicMaterial( { color: 0xffd24d, wireframe: true } ),
	slide: new THREE.MeshBasicMaterial( { color: 0xff8a3c, wireframe: true } ),
	ramp:  new THREE.MeshBasicMaterial( { color: 0x4dd1ff, wireframe: true } ),
	floor: new THREE.MeshBasicMaterial( { color: 0x66ff99, wireframe: true } ),
	wall:  new THREE.MeshBasicMaterial( { color: 0xffffff, wireframe: true } ),
	other: new THREE.MeshBasicMaterial( { color: 0xff4fa3, wireframe: true } ),
};

function debugMatFor( c ) {

	if ( c.grind === true ) return _debugMats.rail;
	if ( c.grind === 'slide' ) return _debugMats.slide;
	if ( c.role === 'ramp' ) return _debugMats.ramp;
	if ( c.role === 'floor' ) return _debugMats.floor;
	if ( c.role === 'wall' ) return _debugMats.wall;
	return _debugMats.other;

}

function addDebugBox( group, collider, halfExtents, position, quaternion ) {

	const geo = new THREE.BoxGeometry( halfExtents[ 0 ] * 2, halfExtents[ 1 ] * 2, halfExtents[ 2 ] * 2 );
	const mesh = new THREE.Mesh( geo, debugMatFor( collider ) );
	mesh.position.set( position[ 0 ], position[ 1 ], position[ 2 ] );
	if ( quaternion ) mesh.quaternion.set( quaternion[ 0 ], quaternion[ 1 ], quaternion[ 2 ], quaternion[ 3 ] );
	group.add( mesh );

}

export function buildParkColliders( world, parkPieces, debugGroup = null ) {

	const grindColliders = [];

	for ( const piece of parkPieces ) {

		const cellPos = piece.group.position;
		const angle = piece.angle || 0;
		_rotQuat.setFromAxisAngle( _up, angle );

		for ( const c of piece.colliders ) {

			// Rotate local collider position around cell center, then translate
			_vec.set( c.position[ 0 ], c.position[ 1 ], c.position[ 2 ] ).applyQuaternion( _rotQuat );
			const worldPos = [ cellPos.x + _vec.x, cellPos.y + _vec.y, cellPos.z + _vec.z ];

			// Compose quaternion: piece rotation ∘ local collider rotation
			if ( c.quaternion ) {

				_tmpQuat.set( c.quaternion[ 0 ], c.quaternion[ 1 ], c.quaternion[ 2 ], c.quaternion[ 3 ] );
				_combinedQuat.copy( _rotQuat ).multiply( _tmpQuat );

			} else {

				_combinedQuat.copy( _rotQuat );

			}
			const worldQuat = [ _combinedQuat.x, _combinedQuat.y, _combinedQuat.z, _combinedQuat.w ];

			const body = rigidBody.create( world, {
				shape: box.create( { halfExtents: c.halfExtents } ),
				motionType: MotionType.STATIC,
				objectLayer: world._OL_STATIC,
				position: worldPos,
				quaternion: worldQuat,
				friction: c.friction ?? 1.0,
				restitution: c.restitution ?? 0.0,
			} );

			if ( c.grind ) {

				// Record grind rails so the skater can detect proximity
				grindColliders.push( {
					body,
					worldPos: new THREE.Vector3( worldPos[ 0 ], worldPos[ 1 ], worldPos[ 2 ] ),
					halfExtents: c.halfExtents,
					quaternion: new THREE.Quaternion( worldQuat[ 0 ], worldQuat[ 1 ], worldQuat[ 2 ], worldQuat[ 3 ] ),
					type: c.grind === true ? 'grind' : c.grind,
				} );

			}

			if ( debugGroup ) addDebugBox( debugGroup, c, c.halfExtents, worldPos, worldQuat );

		}

	}

	return { grindColliders };

}

export function createBigGroundFallback( world, bounds, groundSize ) {

	// Safety floor far below so the skater always has something to land on if
	// a piece is missing. Provides slippery feedback so the respawn kicks in.
	const roadHalf = groundSize / 2 + 20;
	rigidBody.create( world, {
		shape: box.create( { halfExtents: [ roadHalf, 0.01, roadHalf ] } ),
		motionType: MotionType.STATIC,
		objectLayer: world._OL_STATIC,
		position: [ bounds.centerX, - 8, bounds.centerZ ],
		friction: 0.1,
		restitution: 0.0,
	} );

}

export function buildFoundation( world, floorCollider, borderColliders ) {

	if ( floorCollider ) {

		rigidBody.create( world, {
			shape: box.create( { halfExtents: floorCollider.halfExtents } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position: floorCollider.position,
			friction: floorCollider.friction ?? 1.2,
			restitution: 0.0,
		} );

	}

	for ( const wall of borderColliders || [] ) {

		rigidBody.create( world, {
			shape: box.create( { halfExtents: wall.halfExtents } ),
			motionType: MotionType.STATIC,
			objectLayer: world._OL_STATIC,
			position: wall.position,
			friction: wall.friction ?? 0.0,
			restitution: wall.restitution ?? 0.1,
		} );

	}

}

export function createSkaterBody( world, spawnPos ) {

	const body = rigidBody.create( world, {
		shape: sphere.create( { radius: 0.4 } ),
		motionType: MotionType.DYNAMIC,
		objectLayer: world._OL_MOVING,
		position: spawnPos || [ 0, 0.8, 0 ],
		mass: 65.0,
		friction: 3.5,
		restitution: 0.05,
		linearDamping: 0.18,
		angularDamping: 3.0,
		gravityFactor: 1.9,
		motionQuality: MotionQuality.LINEAR_CAST,
	} );

	return body;

}

// ─── Ground check + grind check ─────────────────────────────
//
// We track the last time the skater's sphere had any contact with a static
// body. If a contact has been registered within the coyote window, we treat
// the skater as grounded. This avoids the classic "grounded at apex" bug
// that pure vertical-velocity thresholds produce.

export function createContactTracker( skaterBody ) {

	let lastContactTime = -Infinity;
	let persistedCount = 0;
	let addedCount = 0;

	const listener = {
		onContactAdded( bodyA, bodyB ) {

			if ( bodyA === skaterBody || bodyB === skaterBody ) {

				lastContactTime = performance.now();
				addedCount ++;

			}

		},
		onContactPersisted( bodyA, bodyB ) {

			if ( bodyA === skaterBody || bodyB === skaterBody ) {

				lastContactTime = performance.now();
				persistedCount ++;

			}

		}
	};

	function isGrounded( coyoteMs = 80 ) {

		return ( performance.now() - lastContactTime ) < coyoteMs;

	}

	function debug() {

		return { lastContactTime, sinceLastContact: performance.now() - lastContactTime, persistedCount, addedCount };

	}

	return { listener, isGrounded, debug };

}

const _local = new THREE.Vector3();
const _invQuat = new THREE.Quaternion();

export function findNearestGrindContact( skater, rails, maxDist = 1.6 ) {

	let best = null;
	let bestDist = maxDist;

	for ( const rail of rails ) {

		_local.copy( skater.spherePos ).sub( rail.worldPos );
		_invQuat.copy( rail.quaternion ).invert();
		_local.applyQuaternion( _invQuat );

		const he = rail.halfExtents;
		const longAxisIsZ = he[ 2 ] >= he[ 0 ];
		const along = longAxisIsZ ? _local.z : _local.x;
		const across = longAxisIsZ ? _local.x : _local.z;
		const halfLength = longAxisIsZ ? he[ 2 ] : he[ 0 ];
		const halfWidth = longAxisIsZ ? he[ 0 ] : he[ 2 ];

		// Skater must be within a generous window above the rail's top edge.
		// Bumped up to catch higher jumps onto tall rails / half-pipe lips.
		const dy = _local.y - he[ 1 ];
		if ( dy < - 0.4 || dy > 1.5 ) continue;

		if ( Math.abs( along ) > halfLength + 0.9 ) continue;
		if ( Math.abs( across ) > halfWidth + 0.9 ) continue;

		const lateral = Math.max( 0, Math.abs( across ) - halfWidth );
		const vertical = Math.max( 0, Math.abs( dy - 0.5 ) - 0.5 );
		const d = Math.hypot( lateral, vertical );
		if ( d < bestDist ) {

			best = rail;
			bestDist = d;

		}

	}

	return best;

}
