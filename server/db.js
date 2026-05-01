import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname( fileURLToPath( import.meta.url ) );

// Opens (or creates) the SQLite file at dbPath, runs schema.sql, and returns a
// small API surface rather than the raw connection. Keeps call sites tidy —
// server/index.js doesn't need to know about prepared statements.
export function openDatabase( dbPath ) {

	fs.mkdirSync( path.dirname( dbPath ), { recursive: true } );
	const db = new Database( dbPath );
	db.pragma( 'journal_mode = WAL' );
	db.pragma( 'foreign_keys = ON' );

	const schema = fs.readFileSync( path.join( __dirname, 'schema.sql' ), 'utf8' );
	db.exec( schema );

	const stmts = {
		insertRound:   db.prepare( 'INSERT INTO rounds (started_at, ended_at, winner_name, winner_score, player_count) VALUES (?, ?, ?, ?, ?)' ),
		insertScore:   db.prepare( 'INSERT INTO scores (round_id, display_name, score, created_at) VALUES (?, ?, ?, ?)' ),
		upsertPlayer:  db.prepare( `
			INSERT INTO players (display_name, total_rounds, best_score, created_at)
			VALUES (?, 1, ?, ?)
			ON CONFLICT(display_name) DO UPDATE SET
				total_rounds = total_rounds + 1,
				best_score   = MAX(best_score, excluded.best_score)
		` ),
		topPlayers:    db.prepare( 'SELECT display_name, best_score, total_rounds FROM players ORDER BY best_score DESC LIMIT ?' ),
		recentWinners: db.prepare( `
			SELECT winner_name AS name, winner_score AS score, ended_at
			FROM rounds
			WHERE winner_name IS NOT NULL
			ORDER BY ended_at DESC
			LIMIT ?
		` ),
		insertMap:     db.prepare( 'INSERT INTO maps (code, name, source, data, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)' ),
		selectMap:     db.prepare( 'SELECT code, name, source, data, created_at, created_by FROM maps WHERE code = ?' ),
		recentMaps:    db.prepare( 'SELECT code, name, source, created_at FROM maps WHERE source = ? ORDER BY created_at DESC LIMIT ?' ),
	};

	// All writes for a finished round go through this single transaction so the
	// rounds/scores/players tables can never disagree.
	const saveRound = db.transaction( ( round ) => {

		const roundRow = stmts.insertRound.run(
			round.startedAt,
			round.endedAt,
			round.winnerName || null,
			round.winnerScore || 0,
			round.playerCount || 0,
		);
		const roundId = roundRow.lastInsertRowid;

		const now = Date.now();
		for ( const s of round.scores ) {

			stmts.insertScore.run( roundId, s.name, s.score, now );

		}

		if ( round.winnerName && round.winnerScore > 0 ) {

			stmts.upsertPlayer.run( round.winnerName, round.winnerScore, now );

		}

		return roundId;

	} );

	// Short map code generator — 6 lowercase alphanumeric characters. Retries
	// on collision rather than widening the code, since collisions are rare.
	function newMapCode() {

		const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789';
		for ( let attempt = 0; attempt < 8; attempt ++ ) {

			let code = '';
			for ( let i = 0; i < 6; i ++ ) code += alpha[ Math.floor( Math.random() * alpha.length ) ];
			if ( ! stmts.selectMap.get( code ) ) return code;

		}
		throw new Error( 'could not allocate map code' );

	}

	function saveMap( { name, source, data, createdBy = null } ) {

		const code = newMapCode();
		stmts.insertMap.run( code, name, source, JSON.stringify( data ), Date.now(), createdBy );
		return code;

	}

	function getMap( code ) {

		const row = stmts.selectMap.get( code );
		if ( ! row ) return null;
		return { ...row, data: JSON.parse( row.data ) };

	}

	return {
		db,
		saveRound,
		topPlayers: ( limit = 10 ) => stmts.topPlayers.all( Math.max( 1, Math.min( 100, limit | 0 ) ) ),
		recentWinners: ( limit = 10 ) => stmts.recentWinners.all( Math.max( 1, Math.min( 50, limit | 0 ) ) ),
		saveMap,
		getMap,
		recentMaps: ( source = 'user', limit = 20 ) => stmts.recentMaps.all( source, Math.max( 1, Math.min( 100, limit | 0 ) ) ),
	};

}
