import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const KENNEY_BASE = 'mini-skate/Models/GLB format/';

export const KENNEY_NAMES = [
	'bowl-corner-inner',
	'bowl-corner-outer',
	'bowl-side',
	'character-skate-boy',
	'character-skate-girl',
	'floor-concrete',
	'floor-wood',
	'half-pipe',
	'obstacle-box',
	'obstacle-end',
	'obstacle-middle',
	'pallet',
	'rail-curve',
	'rail-high',
	'rail-low',
	'rail-slope',
	'skateboard',
	'steps',
	'structure-platform',
	'structure-wood',
];

const loader = new GLTFLoader();
const cache = new Map();

export function loadKenney( name ) {

	if ( ! cache.has( name ) ) {

		cache.set( name, loader.loadAsync( KENNEY_BASE + name + '.glb' ) );

	}
	return cache.get( name );

}

export async function preloadKenneyPack( names = KENNEY_NAMES ) {

	await Promise.all( names.map( loadKenney ) );

}

// Instantiate a Kenney GLB centered on its footprint and scaled so that its
// longest horizontal extent matches `targetFootprint`. Returns a THREE.Group
// parked at the origin with its bottom resting on y = 0.
//
// Materials are cloned per-instance so tints do not bleed across copies.
export async function instantiateKenney( name, opts = {} ) {

	const {
		targetFootprint = null,
		tint = null,
		flatShading = true,
		receiveShadow = true,
		castShadow = true,
		alignLongestAxisTo = null,  // 'x' or 'z' — auto-rotate so the model's
		                             // longest horizontal axis ends up on the
		                             // chosen world axis
	} = opts;

	const gltf = await loadKenney( name );

	// Clone the scene so we can safely reparent/transform
	const inner = gltf.scene.clone( true );

	inner.traverse( ( child ) => {

		if ( ! child.isMesh ) return;
		child.castShadow = castShadow;
		child.receiveShadow = receiveShadow;

		if ( Array.isArray( child.material ) ) {

			child.material = child.material.map( ( m ) => m.clone() );

		} else if ( child.material ) {

			child.material = child.material.clone();

		}

		const mats = Array.isArray( child.material ) ? child.material : [ child.material ];
		for ( const m of mats ) {

			if ( ! m ) continue;
			if ( flatShading && 'flatShading' in m ) {

				m.flatShading = true;
				m.needsUpdate = true;

			}
			if ( tint != null && m.color ) m.color.set( tint );

		}

	} );

	// Measure bbox, then scale so the longest horizontal extent = targetFootprint.
	const bbox = new THREE.Box3().setFromObject( inner );
	const size = bbox.getSize( new THREE.Vector3() );

	let scale = 1;
	if ( targetFootprint != null ) {

		const longest = Math.max( size.x, size.z );
		if ( longest > 1e-4 ) scale = targetFootprint / longest;

	}

	inner.scale.setScalar( scale );

	// Optional: rotate 90° around Y so the longest horizontal axis ends up on
	// the requested world axis. Done BEFORE the final bbox/centering pass so
	// the post-rotation bbox drives the centering.
	if ( alignLongestAxisTo ) {

		const longIsX = size.x >= size.z;
		const wantX = alignLongestAxisTo === 'x';
		if ( longIsX !== wantX ) inner.rotation.y = Math.PI / 2;

	}

	// Re-measure after scaling (and optional rotate) to center horizontally +
	// rest the bottom on y=0.
	const scaled = new THREE.Box3().setFromObject( inner );
	const center = scaled.getCenter( new THREE.Vector3() );
	inner.position.x -= center.x;
	inner.position.z -= center.z;
	inner.position.y -= scaled.min.y;

	// Wrap in a plain group so callers can freely rotate / translate without
	// disturbing the child's own local transforms.
	const group = new THREE.Group();
	group.name = name;
	group.add( inner );

	const finalBbox = new THREE.Box3().setFromObject( group );
	const finalSize = finalBbox.getSize( new THREE.Vector3() );

	// Bake the inner transform (scale + optional Y rotation + centering offset)
	// so collider generators can map OBJ-native vertex positions into the same
	// space the visible mesh now lives in.
	inner.updateMatrix();
	const innerMatrix = inner.matrix.clone();

	return {
		group,
		animations: gltf.animations || [],
		size: finalSize,
		scale,
		innerMatrix,
	};

}
