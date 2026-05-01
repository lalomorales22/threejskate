import * as THREE from 'three';

const SPARK_POOL = 48;

const _worldPos = new THREE.Vector3();

function makeSparkTexture() {

	const size = 64;
	const c = document.createElement( 'canvas' );
	c.width = c.height = size;
	const ctx = c.getContext( '2d' );
	ctx.fillStyle = 'rgba(0,0,0,0)';
	ctx.fillRect( 0, 0, size, size );
	ctx.strokeStyle = 'rgba(255,230,120,1)';
	ctx.lineWidth = 4;
	ctx.lineCap = 'round';
	ctx.beginPath();
	ctx.moveTo( 8, size / 2 ); ctx.lineTo( size - 8, size / 2 );
	ctx.moveTo( size / 2, 8 ); ctx.lineTo( size / 2, size - 8 );
	ctx.stroke();
	const tex = new THREE.CanvasTexture( c );
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;

}


export class GrindSparks {

	constructor( scene ) {

		this.particles = [];
		const map = makeSparkTexture();
		this.material = new THREE.SpriteMaterial( {
			map,
			transparent: true,
			depthWrite: false,
			blending: THREE.AdditiveBlending,
			opacity: 0,
			color: 0xffd24a,
		} );

		for ( let i = 0; i < SPARK_POOL; i ++ ) {

			const sprite = new THREE.Sprite( this.material.clone() );
			sprite.visible = false;
			sprite.scale.setScalar( 0.3 );
			scene.add( sprite );

			this.particles.push( {
				sprite,
				life: 0,
				maxLife: 0,
				velocity: new THREE.Vector3(),
				initialScale: 0,
			} );

		}
		this.emitIndex = 0;

	}

	update( dt, skater ) {

		if ( skater.grindActive && Math.abs( skater.linearSpeed ) > 0.15 ) {

			this.emit( skater );
			this.emit( skater );

		}

		for ( const p of this.particles ) {

			if ( p.life <= 0 ) continue;
			p.life -= dt;
			if ( p.life <= 0 ) { p.sprite.visible = false; continue; }

			const t = 1 - ( p.life / p.maxLife );
			p.velocity.y -= dt * 9;
			p.sprite.position.addScaledVector( p.velocity, dt );
			p.sprite.material.opacity = ( 1 - t ) * 1.0;
			p.sprite.scale.setScalar( p.initialScale * ( 1 - t * 0.6 ) );

		}

	}

	emit( skater ) {

		const p = this.particles[ this.emitIndex ];
		this.emitIndex = ( this.emitIndex + 1 ) % SPARK_POOL;

		_worldPos.copy( skater.container.position );
		_worldPos.y += 0.4;

		p.sprite.position.copy( _worldPos );
		p.sprite.visible = true;
		p.sprite.material.opacity = 1;

		p.initialScale = 0.18 + Math.random() * 0.12;
		p.sprite.scale.setScalar( p.initialScale );

		const back = new THREE.Vector3( 0, 0, -1 ).applyQuaternion( skater.container.quaternion );
		p.velocity.set(
			back.x * ( 1 + Math.random() ) + ( Math.random() - 0.5 ) * 1.8,
			1.2 + Math.random() * 1.2,
			back.z * ( 1 + Math.random() ) + ( Math.random() - 0.5 ) * 1.8
		);
		p.maxLife = 0.4;
		p.life = p.maxLife;

	}

}

// ─── Trail FX ────────────────────────────────────────────────
//
// A single sprite pool driven by a trail style: off/sparkles/fire/rainbow.
// Style changes are zero-cost (no rebuilds) — we just swap the particle
// color + velocity recipe used on each spawn.

const TRAIL_POOL = 64;
const TRAIL_SPAWN_SPEED_MIN = 1.2;   // skater ground speed before we emit
const TRAIL_SPAWN_HZ = 28;

function makeTrailTexture() {

	const size = 64;
	const c = document.createElement( 'canvas' );
	c.width = c.height = size;
	const ctx = c.getContext( '2d' );
	const grad = ctx.createRadialGradient( size / 2, size / 2, 0, size / 2, size / 2, size / 2 );
	grad.addColorStop( 0.0, 'rgba(255,255,255,1)' );
	grad.addColorStop( 0.5, 'rgba(255,255,255,0.45)' );
	grad.addColorStop( 1.0, 'rgba(255,255,255,0)' );
	ctx.fillStyle = grad;
	ctx.fillRect( 0, 0, size, size );
	const tex = new THREE.CanvasTexture( c );
	tex.colorSpace = THREE.SRGBColorSpace;
	return tex;

}

export class TrailFX {

	constructor( scene ) {

		this.scene = scene;
		this.style = 'off';
		this.rainbowHue = 0;
		this._spawnAccum = 0;

		const map = makeTrailTexture();
		this.particles = [];
		for ( let i = 0; i < TRAIL_POOL; i ++ ) {

			const mat = new THREE.SpriteMaterial( {
				map,
				transparent: true,
				depthWrite: false,
				blending: THREE.AdditiveBlending,
				color: 0xffffff,
				opacity: 0,
			} );
			const sprite = new THREE.Sprite( mat );
			sprite.visible = false;
			scene.add( sprite );
			this.particles.push( {
				sprite, mat,
				velocity: new THREE.Vector3(),
				life: 0,
				maxLife: 0,
				initialScale: 0.2,
				color: new THREE.Color(),
			} );

		}

	}

	setStyle( style ) { this.style = style || 'off'; }

	dispose() {

		for ( const p of this.particles ) {
			this.scene.remove( p.sprite );
			p.mat.dispose?.();
		}
		this.particles.length = 0;

	}

	update( dt, skater ) {

		// Drive existing particles
		const grav = -0.35;
		for ( const p of this.particles ) {

			if ( p.life <= 0 ) continue;
			p.life -= dt;
			if ( p.life <= 0 ) { p.sprite.visible = false; p.mat.opacity = 0; continue; }

			p.velocity.y += grav * dt;
			p.sprite.position.addScaledVector( p.velocity, dt );

			const t = p.life / p.maxLife;
			p.mat.opacity = t;
			p.sprite.scale.setScalar( p.initialScale * ( 0.6 + 0.4 * t ) );

		}

		if ( this.style === 'off' ) return;

		// Only emit when the skater is actually moving along the ground.
		const speedSq = skater.sphereVel.x * skater.sphereVel.x + skater.sphereVel.z * skater.sphereVel.z;
		if ( speedSq < TRAIL_SPAWN_SPEED_MIN * TRAIL_SPAWN_SPEED_MIN ) return;

		this._spawnAccum += dt * TRAIL_SPAWN_HZ;
		while ( this._spawnAccum >= 1 ) {

			this._spawnAccum -= 1;
			this._spawnOne( skater );

		}

		this.rainbowHue = ( this.rainbowHue + dt * 0.6 ) % 1;

	}

	_spawnOne( skater ) {

		const p = this.particles.find( ( q ) => q.life <= 0 );
		if ( ! p ) return;

		// Emit slightly behind the skater so the trail reads as a wake.
		// Skater's container faces local +Z → apply the quaternion to -Z to
		// get the world-space "backward" direction, and ADD it to position.
		const back = new THREE.Vector3( 0, 0, -1 ).applyQuaternion( skater.container.quaternion );
		p.sprite.position.set(
			skater.spherePos.x + back.x * 0.6 + ( Math.random() - 0.5 ) * 0.2,
			skater.spherePos.y + 0.05,
			skater.spherePos.z + back.z * 0.6 + ( Math.random() - 0.5 ) * 0.2,
		);

		switch ( this.style ) {

			case 'sparkles':
				p.mat.color.setHSL( 0.13, 0.9, 0.75 );
				p.velocity.set(
					( Math.random() - 0.5 ) * 0.8,
					0.6 + Math.random() * 0.9,
					( Math.random() - 0.5 ) * 0.8,
				);
				p.initialScale = 0.12 + Math.random() * 0.08;
				p.maxLife = 0.7 + Math.random() * 0.3;
				break;

			case 'fire':
				p.mat.color.setHSL( 0.03 + Math.random() * 0.05, 0.95, 0.55 );
				p.velocity.set(
					( Math.random() - 0.5 ) * 0.4,
					1.2 + Math.random() * 0.6,
					( Math.random() - 0.5 ) * 0.4,
				);
				p.initialScale = 0.22 + Math.random() * 0.1;
				p.maxLife = 0.55 + Math.random() * 0.2;
				break;

			case 'rainbow':
				p.mat.color.setHSL( this.rainbowHue, 0.95, 0.6 );
				p.velocity.set(
					( Math.random() - 0.5 ) * 0.6,
					0.9 + Math.random() * 0.5,
					( Math.random() - 0.5 ) * 0.6,
				);
				p.initialScale = 0.18 + Math.random() * 0.1;
				p.maxLife = 0.8 + Math.random() * 0.3;
				break;

		}

		p.life = p.maxLife;
		p.mat.opacity = 1;
		p.sprite.scale.setScalar( p.initialScale );
		p.sprite.visible = true;

	}

}
