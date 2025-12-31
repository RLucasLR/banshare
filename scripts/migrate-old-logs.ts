/**
 * Migration script to import old-logs.txt into the banshare database.
 *
 * Run with: npx ts-node scripts/migrate-old-logs.ts
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const COLLECTION_ID = '9f4d1976-eb01-4e01-91a6-1b0e0902a381';
const MODERATOR_GUILD_ID = '884444284630233159';

interface LogEntry {
	lineNumber: number;
	timestamp: string;
	action: 'ban' | 'unban' | 'kick' | 'softban';
	userId: string;
	moderatorName: string;
	moderatorId: string;
	reason: string;
}

const getDbFilePath = () => {
	return path.resolve(__dirname, '..', 'banshare-db.sqllite');
};

const getOldLogsPath = () => {
	return path.resolve(__dirname, '..', 'old-logs.txt');
};

const parseLine = (line: string): LogEntry | null => {
	// Format: lineNum | timestamp | action | userId | modName (modId) | reason
	const parts = line.split(' | ');
	if (parts.length < 5) return null;

	const lineNumber = parseInt(parts[0], 10);
	const timestamp = parts[1];
	const action = parts[2] as LogEntry['action'];
	const userId = parts[3];

	// Parse moderator: "username (id)"
	const modMatch = parts[4].match(/^(.+?) \((\d+)\)$/);
	if (!modMatch) return null;

	const moderatorName = modMatch[1];
	const moderatorId = modMatch[2];
	const reason = parts.slice(5).join(' | ') || '';

	// Only process ban and unban actions
	if (!['ban', 'unban', 'softban'].includes(action)) {
		return null;
	}

	return {
		lineNumber,
		timestamp,
		action,
		userId,
		moderatorName,
		moderatorId,
		reason,
	};
};

const stringifyJson = (value: unknown): string => JSON.stringify(value);
const toDbBool = (value: boolean): 0 | 1 => (value ? 1 : 0);

const run = () => {
	console.log('Starting migration of old-logs.txt...\n');

	const dbPath = getDbFilePath();
	const logsPath = getOldLogsPath();

	console.log(`Database path: ${dbPath}`);
	console.log(`Logs path: ${logsPath}\n`);

	// Read and parse logs
	const logContent = fs.readFileSync(logsPath, 'utf-8');
	const lines = logContent.split('\n').filter((line) => line.trim());

	const entries: LogEntry[] = [];
	for (const line of lines) {
		const entry = parseLine(line);
		if (entry) {
			entries.push(entry);
		}
	}

	console.log(`Parsed ${entries.length} relevant entries (bans/unbans/softbans)\n`);

	// Track which users have been unbanned after their ban
	// We need to process in chronological order to determine final state
	const bansByUser = new Map<string, LogEntry[]>();
	const unbansByUser = new Map<string, LogEntry[]>();

	for (const entry of entries) {
		if (entry.action === 'ban' || entry.action === 'softban') {
			const existing = bansByUser.get(entry.userId) ?? [];
			existing.push(entry);
			bansByUser.set(entry.userId, existing);
		} else if (entry.action === 'unban') {
			const existing = unbansByUser.get(entry.userId) ?? [];
			existing.push(entry);
			unbansByUser.set(entry.userId, existing);
		}
	}

	// Determine if each ban is still active
	// A ban is inactive if there's an unban AFTER it
	const isActiveBan = (ban: LogEntry): boolean => {
		const unbans = unbansByUser.get(ban.userId) ?? [];
		const banTime = new Date(ban.timestamp).getTime();

		for (const unban of unbans) {
			const unbanTime = new Date(unban.timestamp).getTime();
			if (unbanTime > banTime) {
				return false; // There's an unban after this ban
			}
		}
		return true;
	};

	// Connect to database
	const db = new Database(dbPath);
	db.pragma('journal_mode = WAL');
	db.pragma('foreign_keys = ON');

	// Prepare insert statement
	const insertStmt = db.prepare(`
		INSERT INTO bans (
			_id,
			collectionId,
			userId,
			moderatorId,
			moderatorGuildId,
			timestamp,
			expiresAt,
			reason,
			userFacingReason,
			privatiseReason,
			moderatorsInvolvedJson,
			evidenceJson,
			active,
			appliedServersRecentJson,
			appliedServersHistoryJson,
			metaJson
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);

	// Stats
	let inserted = 0;
	let activeCount = 0;
	let inactiveCount = 0;
	let skipped = 0;

	// Process all bans
	const allBans: LogEntry[] = [];
	for (const [, bans] of bansByUser) {
		allBans.push(...bans);
	}

	// Sort by timestamp
	allBans.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

	console.log(`Processing ${allBans.length} ban entries...\n`);

	const transaction = db.transaction(() => {
		for (const ban of allBans) {
			const active = isActiveBan(ban);
			const id = randomUUID();

			try {
				insertStmt.run(
					id,
					COLLECTION_ID,
					ban.userId,
					ban.moderatorId,
					MODERATOR_GUILD_ID,
					ban.timestamp,
					null, // expiresAt
					ban.reason || null, // reason
					null, // userFacingReason (privatised)
					toDbBool(true), // privatiseReason = true
					stringifyJson([]), // moderatorsInvolved
					stringifyJson([]), // evidence (none)
					toDbBool(active), // active
					stringifyJson([]), // appliedServersRecent
					stringifyJson([]), // appliedServersHistory
					stringifyJson({ runs: 0, imported: true }) // meta
				);

				inserted++;
				if (active) {
					activeCount++;
				} else {
					inactiveCount++;
				}

				console.log(
					`[${inserted}] Line ${ban.lineNumber}: User ${ban.userId} - ${active ? 'ACTIVE' : 'INACTIVE'} - Mod: ${ban.moderatorName}`
				);
			} catch (err) {
				console.error(`Failed to insert ban for user ${ban.userId}:`, err);
				skipped++;
			}
		}
	});

	transaction();

	db.close();

	console.log('\n=== Migration Complete ===');
	console.log(`Total inserted: ${inserted}`);
	console.log(`  - Active bans: ${activeCount}`);
	console.log(`  - Inactive bans: ${inactiveCount}`);
	console.log(`Skipped/errors: ${skipped}`);
	console.log(`Collection ID: ${COLLECTION_ID}`);
	console.log(`Moderator Guild ID: ${MODERATOR_GUILD_ID}`);
};

run();
