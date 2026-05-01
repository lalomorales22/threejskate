import * as THREE from 'three';

// Slightly lower + closer than the car camera so ramps feel tall.
export class Camera {

	constructor() {

		this.camera = new THREE.PerspectiveCamera( 42, window.innerWidth / window.innerHeight, 0.1, 120 );

		// 40° azimuth, ~27° elevation, distance 14
		this.offset = new THREE.Vector3( 9, 6.3, 9 );
		this.targetPosition = new THREE.Vector3();
		this.lookTarget = new THREE.Vector3();

		this.camera.position.copy( this.offset );
		this.camera.lookAt( 0, 0, 0 );

		window.addEventListener( 'resize', () => {

			this.camera.aspect = window.innerWidth / window.innerHeight;
			this.camera.updateProjectionMatrix();

		} );

	}

	update( dt, target, skaterVelocity ) {

		this.targetPosition.lerp( target, dt * 4 );

		// Gentle lead-ahead based on velocity so the skater doesn't feel pinned
		this.lookTarget.copy( this.targetPosition );
		if ( skaterVelocity ) {

			this.lookTarget.x += skaterVelocity.x * 0.12;
			this.lookTarget.z += skaterVelocity.z * 0.12;

		}

		this.camera.position.copy( this.targetPosition ).add( this.offset );
		this.camera.lookAt( this.lookTarget );

	}

}
