// Shared loadout schema + palettes for procedural skaters.
//
// A loadout is a plain JSON object — easy to persist in localStorage and
// wire-safe. applyLoadout mutates the materials stored in a skater model's
// userData so both the local rider and RemoteSkater peers stay in lockstep.

export const HATS   = [ 'none', 'helmet', 'beanie', 'cap' ];
export const TRAILS = [ 'off',  'sparkles', 'fire', 'rainbow' ];

// Hand-picked swatches that all read well against the Kenney palette and
// each other. Each array is ~8 options so the randomize button has variety
// without drifting into ugly-pastel territory.
export const SWATCHES = {
	skin:   [ 0xe8b084, 0xc78a5a, 0x8a5a3a, 0xf4cda6, 0x6d4630, 0xe0a07a, 0xd89b6e, 0xa56b3e ],
	shirt:  [ 0xe05252, 0x4b9a9a, 0x8e5ab8, 0xf4c24e, 0x3f7a4a, 0x2b6fc7, 0xef8a3a, 0xf06ea6, 0x2a2a33, 0xffffff ],
	pants:  [ 0x2b2b38, 0x1f2a44, 0x262633, 0x3a2b1e, 0x444e57, 0x1a1a20, 0x4f3b7a, 0x7a5a2e ],
	shoes:  [ 0xffffff, 0x222222, 0xffd24a, 0xe05252, 0x4b9a9a, 0xa04030, 0x6a6a6a, 0xf06ea6 ],
	deck:   [ 0x2f4a7a, 0xa04030, 0x202028, 0x3f7a4a, 0xe05252, 0xf4c24e, 0x8e5ab8, 0x5c3a1e, 0xf06ea6, 0x2a8a9a ],
	wheels: [ 0xf0e7c8, 0xfff2c4, 0xff6060, 0xffd24a, 0x4ad0ff, 0xb0ffb0, 0xffffff, 0x2a2a33 ],
	hatColor: [ 0xf4c24e, 0xffffff, 0xf07a3c, 0xe05252, 0x4b9a9a, 0x222222, 0x8e5ab8, 0xf06ea6, 0x3f7a4a ],
};

export const DEFAULT_LOADOUT = {
	skin:    SWATCHES.skin[ 0 ],
	shirt:   SWATCHES.shirt[ 0 ],
	pants:   SWATCHES.pants[ 0 ],
	shoes:   SWATCHES.shoes[ 0 ],
	deck:    SWATCHES.deck[ 0 ],
	wheels:  SWATCHES.wheels[ 0 ],
	hat:     'helmet',
	hatColor: SWATCHES.hatColor[ 0 ],
	trail:   'off',
};

// Back-compat with the ?p= URL param from the pre-loadout era.
const PALETTE_PRESETS = [
	{ shirt: 0xe05252, pants: 0x2b2b38, hatColor: 0xf4c24e, shoes: 0xffffff, skin: 0xe8b084, deck: 0x2f4a7a, wheels: 0xf0e7c8 },
	{ shirt: 0x4b9a9a, pants: 0x1f2a44, hatColor: 0xf07a3c, shoes: 0x222222, skin: 0xc78a5a, deck: 0xa04030, wheels: 0xfff2c4 },
	{ shirt: 0x8e5ab8, pants: 0x262633, hatColor: 0xffffff, shoes: 0xffd24a, skin: 0xe0a07a, deck: 0x202028, wheels: 0xff6060 },
];

export function loadoutFromPalette( index = 0 ) {

	const p = PALETTE_PRESETS[ ( index | 0 ) % PALETTE_PRESETS.length ];
	return { ...DEFAULT_LOADOUT, ...p };

}

// Probabilities for the Randomize button. Rarities add dopamine.
const TRAIL_WEIGHTS = [
	[ 'off',      0.30 ],
	[ 'sparkles', 0.35 ],
	[ 'fire',     0.25 ],
	[ 'rainbow',  0.10 ],
];
const HAT_WEIGHTS = [
	[ 'helmet', 0.45 ],
	[ 'beanie', 0.30 ],
	[ 'cap',    0.20 ],
	[ 'none',   0.05 ],
];

export function randomLoadout() {

	return {
		skin:     pick( SWATCHES.skin ),
		shirt:    pick( SWATCHES.shirt ),
		pants:    pick( SWATCHES.pants ),
		shoes:    pick( SWATCHES.shoes ),
		deck:     pick( SWATCHES.deck ),
		wheels:   pick( SWATCHES.wheels ),
		hat:      weighted( HAT_WEIGHTS ),
		hatColor: pick( SWATCHES.hatColor ),
		trail:    weighted( TRAIL_WEIGHTS ),
	};

}

function pick( arr ) { return arr[ Math.floor( Math.random() * arr.length ) ]; }

function weighted( pairs ) {

	const total = pairs.reduce( ( s, [ , w ] ) => s + w, 0 );
	let r = Math.random() * total;
	for ( const [ value, w ] of pairs ) {
		r -= w;
		if ( r <= 0 ) return value;
	}
	return pairs[ 0 ][ 0 ];

}

// Ensure an arbitrary object is a safe, complete loadout. Drops unknown
// fields, clamps enums, falls back to defaults. Used on both client and
// as a template for server-side validation.
export function sanitizeLoadout( raw ) {

	const out = { ...DEFAULT_LOADOUT };
	if ( ! raw || typeof raw !== 'object' ) return out;
	for ( const k of [ 'skin', 'shirt', 'pants', 'shoes', 'deck', 'wheels', 'hatColor' ] ) {
		if ( Number.isFinite( raw[ k ] ) ) out[ k ] = ( raw[ k ] | 0 ) & 0xffffff;
	}
	if ( HATS.includes( raw.hat ) )     out.hat   = raw.hat;
	if ( TRAILS.includes( raw.trail ) ) out.trail = raw.trail;
	return out;

}

// Mutates a skater model's materials + hat visibility in place. Cheap and
// idempotent — call it any time loadout state changes.
export function applyLoadout( model, loadout ) {

	const mats = model?.userData?.materials;
	const hats = model?.userData?.hats;
	if ( ! mats ) return;

	const l = sanitizeLoadout( loadout );

	mats.shirt.color.setHex( l.shirt );
	mats.pants.color.setHex( l.pants );
	mats.shoes.color.setHex( l.shoes );
	mats.skin.color.setHex( l.skin );
	mats.deck.color.setHex( l.deck );
	mats.wheels.color.setHex( l.wheels );
	mats.hatColor.color.setHex( l.hatColor );

	if ( hats ) {

		for ( const [ key, mesh ] of Object.entries( hats ) ) {
			mesh.visible = ( l.hat === key );
		}

	}

	model.userData.loadout = l;

}
