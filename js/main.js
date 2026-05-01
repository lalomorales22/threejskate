import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { LightProbeGrid } from 'three/addons/lighting/LightProbeGrid.js';
import {
	createWorldSettings, createWorld, addBroadphaseLayer, addObjectLayer,
	enableCollision, registerAll, updateWorld
} from 'crashcat';

import { Skater, MAX_SPEED } from './Skater.js';
import { Camera } from './Camera.js';
import { Controls } from './Controls.js';
import { buildPark, loadObjectAssets, decodeCells, computeSpawnPosition, computeParkBounds, DEFAULT_PARK, scatterFromMapData } from './Park.js';
import { buildParkColliders, createSkaterBody, createBigGroundFallback, buildFoundation, createContactTracker, findNearestGrindContact } from './Physics.js';
import { GrindSparks, TrailFX } from './Particles.js';
import { instantiateKenney } from './Assets.js';
import { Net } from './Net.js';
import { RemoteSkater } from './RemoteSkater.js';
import { Leaderboard } from './Leaderboard.js';
import { Customizer, loadStoredLoadout, persistLoadout } from './Customizer.js';
import { loadoutFromPalette } from './Loadout.js';
import { Editor } from './Editor.js';


// ─── Renderer + scene ───────────────────────────────────────

const renderer = new THREE.WebGLRenderer( { antialias: true, outputBufferType: THREE.HalfFloatType } );
renderer.setSize( window.innerWidth, window.innerHeight );
renderer.setPixelRatio( window.devicePixelRatio );
renderer.shadowMap.enabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;

const bloomPass = new UnrealBloomPass( new THREE.Vector2( window.innerWidth, window.innerHeight ) );
bloomPass.strength = 0.08;
bloomPass.radius = 0.3;
bloomPass.threshold = 0.85;
renderer.setEffects( [ bloomPass ] );

document.body.appendChild( renderer.domElement );

const scene = new THREE.Scene();
// Kenney Mini Skate reads best under a brighter, slightly cooler sky — the
// models are flat-shaded low-poly, so we rely on the hemisphere light to
// carry the character of the materials rather than bouncing indirect light.
const SKY_COLOR = 0xcfe0ef;
scene.background = new THREE.Color( SKY_COLOR );
scene.fog = new THREE.Fog( SKY_COLOR, 30, 80 );

const dirLight = new THREE.DirectionalLight( 0xfff1cf, 2.4 );
dirLight.position.set( 10, 14, -4 );
dirLight.castShadow = true;
dirLight.shadow.mapSize.setScalar( 2048 );
dirLight.shadow.camera.near = 0.5;
dirLight.shadow.camera.far = 70;
dirLight.shadow.radius = 2;
dirLight.shadow.bias = -0.0005;
scene.add( dirLight );

const hemiLight = new THREE.HemisphereLight( 0xbdd3e6, 0x6d7860, 1.9 );
hemiLight.position.copy( dirLight.position );
scene.add( hemiLight );

window.addEventListener( 'resize', () => {

	renderer.setSize( window.innerWidth, window.innerHeight );

} );

// ─── HUD helpers ────────────────────────────────────────────

const hudScore = document.getElementById( 'score' );
const hudCombo = document.getElementById( 'combo' );
const trickPopup = document.getElementById( 'trick-popup' );
let trickPopupTimer = null;

function showTrick( text ) {

	trickPopup.textContent = text;
	trickPopup.classList.add( 'show' );
	clearTimeout( trickPopupTimer );
	trickPopupTimer = setTimeout( () => trickPopup.classList.remove( 'show' ), 900 );

}

function updateHud( score, combo ) {

	hudScore.textContent = String( score );
	hudCombo.textContent = combo ? combo : '\u00a0';

}

// ─── Init ───────────────────────────────────────────────────

async function init() {

	registerAll();

	const urlParams = new URLSearchParams( window.location.search );

	// Legacy cell-based map param (pre-Kenney)
	const mapParam = urlParams.get( 'map' );
	let parkCells = null;
	if ( mapParam ) {
		try { parkCells = decodeCells( mapParam ); }
		catch ( e ) { console.warn( 'Invalid map param, using default park', e ); }
	}

	// New Kenney-based map: ?m=<code> fetched from /api/map/:code. If no code
	// is in the URL, ask the server what its current park is so first-time
	// visitors land on the same random map everyone else is skating on.
	let mapData = null;
	let mapCodeParam = urlParams.get( 'm' );

	if ( ! mapCodeParam ) {

		try {
			const res = await fetch( '/api/current-map' );
			if ( res.ok ) {
				const { code } = await res.json();
				if ( code ) {
					mapCodeParam = code;
					// Update the URL without reloading so a refresh stays on this park.
					const u = new URL( window.location.href );
					u.searchParams.set( 'm', code );
					history.replaceState( {}, '', u.toString() );
				}
			}
		} catch ( e ) { /* server down or offline — fall through to default scatter */ }

	}

	if ( mapCodeParam ) {

		try {
			const res = await fetch( `/api/map/${ encodeURIComponent( mapCodeParam ) }` );
			if ( res.ok ) mapData = ( await res.json() ).data;
		} catch ( e ) { console.warn( 'Failed to fetch map', mapCodeParam, e ); }

	}

	const scatter = mapData ? scatterFromMapData( mapData ) : undefined;
	const mapSpawn = mapData ? mapData.spawn : null;

	const spawn = computeSpawnPosition( parkCells || DEFAULT_PARK, mapSpawn );
	const bounds = computeParkBounds( parkCells || DEFAULT_PARK, scatter );

	const hw = bounds.halfWidth;
	const hd = bounds.halfDepth;
	const groundSize = Math.max( hw, hd ) * 2 + 20;

	const shadowExtent = Math.max( hw, hd ) + 10;
	dirLight.shadow.camera.left = - shadowExtent;
	dirLight.shadow.camera.right = shadowExtent;
	dirLight.shadow.camera.top = shadowExtent;
	dirLight.shadow.camera.bottom = - shadowExtent;
	dirLight.shadow.camera.updateProjectionMatrix();

	scene.fog.near = groundSize * 0.35;
	scene.fog.far  = groundSize * 0.9;

	// Build park
	const park = buildPark( scene, parkCells, { scatter } );
	await loadObjectAssets( park, scatter );

	// Bake light probes for soft indirect lighting
	const probeHeight = 4;
	const probes = new LightProbeGrid(
		hw * 2, probeHeight, hd * 2,
		Math.max( 4, Math.round( hw / 3 ) ),
		2,
		Math.max( 4, Math.round( hd / 3 ) ),
	);
	probes.position.set( bounds.centerX, probeHeight / 2, bounds.centerZ );
	probes.bake( renderer, scene, { cubemapSize: 32, near: 0.1, far: groundSize } );
	scene.add( probes );

	// Physics world
	const worldSettings = createWorldSettings();
	worldSettings.gravity = [ 0, - 18, 0 ];

	const BPL_MOVING = addBroadphaseLayer( worldSettings );
	const BPL_STATIC = addBroadphaseLayer( worldSettings );
	const OL_MOVING = addObjectLayer( worldSettings, BPL_MOVING );
	const OL_STATIC = addObjectLayer( worldSettings, BPL_STATIC );

	enableCollision( worldSettings, OL_MOVING, OL_STATIC );
	enableCollision( worldSettings, OL_MOVING, OL_MOVING );

	const world = createWorld( worldSettings );
	world._OL_MOVING = OL_MOVING;
	world._OL_STATIC = OL_STATIC;

	buildFoundation( world, park.floorCollider, park.borderColliders );

	// Wireframe visualization of every piece collider. Hidden by default;
	// toggled with the G key so the user can eyeball which surfaces are rails
	// vs ramps vs ledges when debugging physics.
	const debugColliderGroup = new THREE.Group();
	debugColliderGroup.name = 'collider-debug';
	debugColliderGroup.visible = false;
	scene.add( debugColliderGroup );

	const { grindColliders } = buildParkColliders( world, park.pieces, debugColliderGroup );
	createBigGroundFallback( world, bounds, groundSize );

	window.addEventListener( 'keydown', ( ev ) => {

		if ( ev.code === 'KeyG' && ! ev.repeat && ! ev.metaKey && ! ev.ctrlKey && ! ev.altKey ) {

			const tag = ( ev.target && ev.target.tagName ) || '';
			if ( tag === 'INPUT' || tag === 'TEXTAREA' ) return;
			debugColliderGroup.visible = ! debugColliderGroup.visible;

		}

	} );

	const sphereBody = createSkaterBody( world, spawn.position );

	// Skater
	const skater = new Skater();
	skater.rigidBody = sphereBody;
	skater.physicsWorld = world;

	const [ sx, sy, sz ] = spawn.position;
	skater.spherePos.set( sx, sy, sz );
	skater.prevModelPos.set( sx, 0, sz );
	skater.container.rotation.y = spawn.angle;

	// Resolve initial loadout: localStorage wins, fall back to ?p= palette.
	const paletteIndex = Number( new URLSearchParams( window.location.search ).get( 'p' ) ?? 0 );
	const initialLoadout = loadStoredLoadout() || loadoutFromPalette( paletteIndex );

	const skaterGroup = skater.init( initialLoadout );
	scene.add( skaterGroup );

	// Swap the procedural deck visuals for the Kenney skateboard GLB.
	// The procedural board was 0.82 long along Z; match that footprint.
	try {
		// Auto-align so the skateboard's long axis ends up on world Z — the
		// same axis the procedural rider's feet are spread across, so the
		// rider stands perpendicular to the board.
		const { group: boardModel } = await instantiateKenney( 'skateboard', {
			targetFootprint: 0.82,
			alignLongestAxisTo: 'z',
			flatShading: true,
		} );
		skater.setKenneyBoard( boardModel, { yOffset: -0.05 } );
	} catch ( err ) {
		console.warn( 'Kenney skateboard failed to load — using procedural board.', err );
	}

	dirLight.target = skaterGroup;

	const cam = new Camera();
	cam.targetPosition.copy( skater.spherePos );

	const controls = new Controls();

	const sparks = new GrindSparks( scene );
	const trail  = new TrailFX( scene );
	trail.setStyle( skater.loadout.trail );

	const contacts = createContactTracker( sphereBody );
	const groundCheck = ( coyoteMs = 80 ) => contacts.isGrounded( coyoteMs );

	// ─── Multiplayer ────────────────────────────────────────────
	const netChip = document.getElementById( 'net-chip' );
	const netCount = document.getElementById( 'net-count' );
	const remotes = new Map();  // playerId -> RemoteSkater

	function refreshNetChip() {

		const peers = remotes.size;
		if ( net.connected ) {

			netChip.classList.add( 'online' );
			netCount.textContent = peers === 0 ? 'solo' : `${ peers } skating`;

		} else {

			netChip.classList.remove( 'online' );
			netCount.textContent = 'offline';

		}

	}

	const displayName = ( urlParams.get( 'name' ) || 'skater' ).slice( 0, 24 );

	const net = new Net( {
		profile: {
			name: displayName,
			palette: paletteIndex,
			stance: skater.stance,
			loadout: skater.loadout,
		},
	} );

	net.on( 'open',  refreshNetChip );
	net.on( 'close', refreshNetChip );

	net.on( 'welcome', ( msg ) => {

		for ( const peer of msg.peers || [] ) {

			spawnRemote( peer.playerId, peer );
			if ( peer.state ) remotes.get( peer.playerId )?.pushState( peer.state );

		}
		refreshNetChip();

	} );

	net.on( 'peer_join', ( msg ) => { spawnRemote( msg.playerId, msg ); refreshNetChip(); } );
	net.on( 'peer_left', ( msg ) => {

		const rs = remotes.get( msg.playerId );
		if ( rs ) { rs.dispose( scene ); remotes.delete( msg.playerId ); }
		refreshNetChip();

	} );
	net.on( 'peer_state',   ( msg ) => remotes.get( msg.playerId )?.pushState( msg ) );
	net.on( 'peer_trick',   ( msg ) => remotes.get( msg.playerId )?.showTrick( msg.name ) );
	net.on( 'peer_profile', ( msg ) => remotes.get( msg.playerId )?.setProfile( msg ) );

	function spawnRemote( playerId, profile ) {

		if ( remotes.has( playerId ) ) return;
		const rs = new RemoteSkater( { playerId, profile, scene } );
		remotes.set( playerId, rs );

	}

	// Broadcast local tricks so peers see them pop above your head.
	skater.on( 'trick', ( ev ) => {

		if ( ev.commit || ! ev.name ) return;
		net.sendTrick( ev.name, ev.value || 0, skater.comboScore || 0 );

	} );

	refreshNetChip();

	// Round overlay (banner, live scoreboard, leaderboard, name-entry modal).
	const leaderboard = new Leaderboard( { net } );

	// Customizer — press F1 to open. Changes apply instantly, persist to
	// localStorage, and broadcast to peers via the profile message.
	const customizer = new Customizer( {
		initialLoadout: skater.loadout,
		onChange: ( loadout ) => {

			skater.setLoadout( loadout );
			trail.setStyle( loadout.trail );
			persistLoadout( loadout );
			net.sendProfile( { loadout } );

		},
	} );

	// Map editor — press M to open. Builds user parks that save to the server
	// and share via short codes.
	const editor = new Editor();

	// Reset the local skater's score when a fresh round kicks off so the HUD
	// matches the server-side tally. Server is the source of truth — this is
	// just visual.
	//
	// Also handles inter-round map swaps: when the server rolls a new map
	// during cooldown, we pick it up and soft-reload at the start of the
	// next warmup with ?m=<newCode>, so every round feels fresh without the
	// complexity of an in-place park rebuild.
	let prevPhase = null;
	const currentMapCode = mapData ? mapData.seed || mapCodeParam : null;
	let pendingMapCode = null;

	net.on( 'round_state', ( msg ) => {

		if ( msg.phase === 'round' && prevPhase !== 'round' ) {

			skater.score = 0;
			skater.comboScore = 0;
			skater.comboLabel = '';
			skater.comboTimer = 0;
			updateHud( 0, '' );

		}

		// Server has a different map than we're skating on — queue a swap.
		if ( msg.mapCode && msg.mapCode !== mapCodeParam && msg.mapCode !== currentMapCode ) {

			pendingMapCode = msg.mapCode;

		}

		// Perform the swap the moment we enter WARMUP from any other phase.
		if ( msg.phase === 'warmup' && prevPhase && prevPhase !== 'warmup' && pendingMapCode ) {

			const url = new URL( window.location.href );
			url.searchParams.set( 'm', pendingMapCode );
			window.location.href = url.toString();

		}

		prevPhase = msg.phase;

	} );

	// HUD + combo bus
	skater.on( 'trick', ( ev ) => {

		if ( ev.commit ) {

			updateHud( skater.score, '' );
			return;

		}

		skater.comboScore += ev.value;
		skater.comboLabel = ev.name;
		skater.comboTimer = 1.4;
		showTrick( ev.name.toUpperCase() + ( ev.value > 0 ? `  +${ ev.value }` : '' ) );
		updateHud( skater.score + skater.comboScore, `${ skater.comboLabel } · +${ skater.comboScore }` );

	} );

	updateHud( 0, '' );

	const contactListener = contacts.listener;

	const timer = new THREE.Timer();

	function animate() {

		requestAnimationFrame( animate );

		timer.update();
		const dt = Math.min( timer.getDelta(), 1 / 30 );

		const input = controls.update();
		const evs = input.events;

		// Stance toggle (Shift) — instant flip between regular and goofy
		if ( evs.stanceToggle ) {

			skater.toggleStance();
			net.sendProfile( { stance: skater.stance } );

		}

		// Ollie: hold Space to crouch, release to pop with the current direction
		if ( evs.ollieHeld ) skater.chargeOllie( dt );
		if ( evs.ollieUp )   skater.releaseOllie( evs.dir );

		// Flip tricks — air only, tap once per combo
		if ( evs.flipDown ) skater.performFlip( evs.dir );

		// Grab tricks — held. Direction captured on key-down.
		if ( evs.grabDown ) skater.performGrabDown( evs.dir );
		if ( evs.grabUp )   skater.performGrabUp();

		// Grind tricks — requires a nearby rail / ledge at the moment of press
		if ( evs.grindDown ) {

			const rail = findNearestGrindContact( skater, grindColliders );
			if ( rail ) skater.performGrindDown( evs.dir, rail );

		}
		if ( ! evs.grindHeld && skater.grindActive ) skater.stopGrind();

		updateWorld( world, contactListener, dt );

		skater.update( dt, input, groundCheck );

		// Keep light following skater so long parks still cast sharp shadows
		dirLight.position.set(
			skater.spherePos.x + 10,
			14,
			skater.spherePos.z - 4
		);

		cam.update( dt, skater.spherePos, skater.sphereVel );
		sparks.update( dt, skater );
		trail.update( dt, skater );

		// Multiplayer tick: throttled state send + remote interpolation.
		net.sendState( skater );
		for ( const rs of remotes.values() ) rs.update( dt, cam.camera );

		renderer.render( scene, cam.camera );

	}

	animate();

}

init();
