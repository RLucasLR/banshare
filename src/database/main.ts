import Database from 'better-sqlite3';
import path from 'node:path';

let db: Database.Database | null = null;

const getDbFilePath = () => {
	return path.resolve(__dirname, '..', '..', 'banshare-db.sqllite');
};

export const connectDb = (): Database.Database => {
	if (db) return db;

	db = new Database(getDbFilePath());
	db.pragma('journal_mode = WAL');
	db.pragma('foreign_keys = ON');

	return db;
};

export const initDb = (): void => {
	const database = connectDb();

	database.exec(`
		CREATE TABLE IF NOT EXISTS banshare_meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS collections (
			_id TEXT PRIMARY KEY,
			mainGuildId TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL,
			description TEXT,
			createdAt TEXT NOT NULL,
			createdBy TEXT NOT NULL,
			loggingEnabledAtCollectionLevel INTEGER NOT NULL DEFAULT 1 CHECK (loggingEnabledAtCollectionLevel IN (0, 1)),
			onServerRemove TEXT NOT NULL DEFAULT 'retain' CHECK (onServerRemove IN ('retain', 'lift', 'archive')),
			dmOnBan INTEGER NOT NULL DEFAULT 0 CHECK (dmOnBan IN (0, 1)),
			analyticsEnabled INTEGER NOT NULL DEFAULT 0 CHECK (analyticsEnabled IN (0, 1)),
			maxLinkedServers INTEGER NOT NULL DEFAULT 30 CHECK (maxLinkedServers > 0)
		);

		CREATE TABLE IF NOT EXISTS servers (
			_id TEXT PRIMARY KEY,
			guildId TEXT NOT NULL,
			collectionId TEXT NOT NULL,
			addedAt TEXT NOT NULL,
			addedBy TEXT NOT NULL,
			loggingChannelId TEXT,
			syncOnJoin INTEGER NOT NULL DEFAULT 1 CHECK (syncOnJoin IN (0, 1)),
			enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
			FOREIGN KEY (collectionId) REFERENCES collections(_id)
		);

		CREATE UNIQUE INDEX IF NOT EXISTS servers_collection_guild_unique ON servers (collectionId, guildId);
		CREATE INDEX IF NOT EXISTS servers_collection_idx ON servers (collectionId);

		CREATE TABLE IF NOT EXISTS bans (
			_id TEXT PRIMARY KEY,
			collectionId TEXT NOT NULL,
			userId TEXT NOT NULL,
			moderatorId TEXT NOT NULL,
			moderatorGuildId TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			expiresAt TEXT,
			reason TEXT,
			userFacingReason TEXT,
			privatiseReason INTEGER NOT NULL DEFAULT 1 CHECK (privatiseReason IN (0, 1)),
			moderatorsInvolvedJson TEXT NOT NULL DEFAULT '[]',
			evidenceJson TEXT NOT NULL DEFAULT '[]',
			active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
			appliedServersRecentJson TEXT NOT NULL DEFAULT '[]',
			appliedServersHistoryJson TEXT NOT NULL DEFAULT '[]',
			metaJson TEXT NOT NULL DEFAULT '{}',
			FOREIGN KEY (collectionId) REFERENCES collections(_id)
		);

		CREATE INDEX IF NOT EXISTS bans_collection_idx ON bans (collectionId);
		CREATE INDEX IF NOT EXISTS bans_collection_user_idx ON bans (collectionId, userId);
		CREATE INDEX IF NOT EXISTS bans_collection_active_idx ON bans (collectionId, active);

		CREATE TABLE IF NOT EXISTS moderators (
			_id TEXT PRIMARY KEY,
			collectionId TEXT NOT NULL,
			type TEXT NOT NULL CHECK (type IN ('user', 'role')),
			value TEXT NOT NULL,
			grantedBy TEXT NOT NULL,
			grantedAt TEXT NOT NULL,
			FOREIGN KEY (collectionId) REFERENCES collections(_id)
		);

		CREATE UNIQUE INDEX IF NOT EXISTS moderators_collection_type_value_unique ON moderators (collectionId, type, value);
		CREATE INDEX IF NOT EXISTS moderators_collection_idx ON moderators (collectionId);

		CREATE TABLE IF NOT EXISTS auditLogs (
			_id TEXT PRIMARY KEY,
			collectionId TEXT NOT NULL,
			action TEXT NOT NULL,
			performedBy TEXT NOT NULL,
			performedAt TEXT NOT NULL,
			detailsJson TEXT NOT NULL DEFAULT '{}',
			FOREIGN KEY (collectionId) REFERENCES collections(_id)
		);

		CREATE INDEX IF NOT EXISTS auditLogs_collection_idx ON auditLogs (collectionId);
		CREATE INDEX IF NOT EXISTS auditLogs_collection_time_idx ON auditLogs (collectionId, performedAt);
		CREATE INDEX IF NOT EXISTS auditLogs_action_idx ON auditLogs (action);

		CREATE TABLE IF NOT EXISTS invites (
			_id TEXT PRIMARY KEY,
			collectionId TEXT NOT NULL,
			targetGuildId TEXT NOT NULL,
			invitedBy TEXT NOT NULL,
			invitedAt TEXT NOT NULL,
			expiresAt TEXT NOT NULL,
			status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired', 'cancelled')),
			respondedAt TEXT,
			FOREIGN KEY (collectionId) REFERENCES collections(_id)
		);

		CREATE INDEX IF NOT EXISTS invites_collection_idx ON invites (collectionId);
		CREATE INDEX IF NOT EXISTS invites_target_guild_idx ON invites (targetGuildId);
		CREATE INDEX IF NOT EXISTS invites_status_idx ON invites (status);
	`);
};
