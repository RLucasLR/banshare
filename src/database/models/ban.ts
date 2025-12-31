import { connectDb } from '../main';
import { fromDbBool, newId, nowIso, parseJson, RecordNotFoundError, stringifyJson, toDbBool } from './shared';

export type EvidenceType = 'image' | 'link' | 'text';
export type EvidenceStorage = 's3' | 'gridfs' | 'external';

export interface EvidenceEntry {
	id: string;
	type: EvidenceType;
	storage: EvidenceStorage;
	ref: string;
	notes?: string | null;
	sizeBytes: number;
}

export type AppliedServerResult = 'success' | 'failed' | 'skipped' | 'no_perm' | 'already_banned';

export interface AppliedServerRunEntry {
	guildId: string;
	runId: string;
	appliedAt: string | null;
	result: AppliedServerResult;
	error?: string;
	retryCount: number;
}

export interface BanMeta {
	lastRunId?: string;
	runs?: number;
}

export interface BanCreateInput {
	collectionId: string;
	userId: string;
	moderatorId: string;
	moderatorGuildId: string;
	expiresAt?: string | null;
	reason?: string | null;
	userFacingReason?: string | null;
	privatiseReason?: boolean;
	moderatorsInvolved?: string[];
	evidence?: EvidenceEntry[];
	active?: boolean;
	appliedServersRecent?: AppliedServerRunEntry[];
	appliedServersHistory?: AppliedServerRunEntry[];
	meta?: BanMeta;
}

interface BanRow {
	_id: string;
	collectionId: string;
	userId: string;
	moderatorId: string;
	moderatorGuildId: string;
	timestamp: string;
	expiresAt: string | null;
	reason: string | null;
	userFacingReason: string | null;
	privatiseReason: 0 | 1;
	moderatorsInvolvedJson: string;
	evidenceJson: string;
	active: 0 | 1;
	appliedServersRecentJson: string;
	appliedServersHistoryJson: string;
	metaJson: string;
}

const hydrateBan = (row: BanRow): Ban => {
	const instance = Object.create(Ban.prototype) as Ban;
	instance.applyRow(row);
	return instance;
};

export class Ban {
	public get id(): string {
		return this._id;
	}

	public get collectionId(): string {
		return this._collectionId;
	}
	public set collectionId(value: string) {
		this._collectionId = value;
	}

	public get userId(): string {
		return this._userId;
	}
	public set userId(value: string) {
		this._userId = value;
	}

	public get moderatorId(): string {
		return this._moderatorId;
	}
	public set moderatorId(value: string) {
		this._moderatorId = value;
	}

	public get moderatorGuildId(): string {
		return this._moderatorGuildId;
	}
	public set moderatorGuildId(value: string) {
		this._moderatorGuildId = value;
	}

	public get timestamp(): string {
		return this._timestamp;
	}

	public get expiresAt(): string | null {
		return this._expiresAt;
	}
	public set expiresAt(value: string | null) {
		this._expiresAt = value;
	}

	public get reason(): string | null {
		return this._reason;
	}
	public set reason(value: string | null) {
		this._reason = value;
	}

	public get userFacingReason(): string | null {
		return this._userFacingReason;
	}
	public set userFacingReason(value: string | null) {
		this._userFacingReason = value;
	}

	public get privatiseReason(): boolean {
		return this._privatiseReason;
	}
	public set privatiseReason(value: boolean) {
		this._privatiseReason = value;
	}

	public get moderatorsInvolved(): string[] {
		return this._moderatorsInvolved;
	}
	public set moderatorsInvolved(value: string[]) {
		this._moderatorsInvolved = value;
	}

	public get evidence(): EvidenceEntry[] {
		return this._evidence;
	}
	public set evidence(value: EvidenceEntry[]) {
		if (value.length > 5) throw new Error('evidence max 5 entries');
		this._evidence = value;
	}

	public get active(): boolean {
		return this._active;
	}
	public set active(value: boolean) {
		this._active = value;
	}

	public get appliedServersRecent(): AppliedServerRunEntry[] {
		return this._appliedServersRecent;
	}
	public set appliedServersRecent(value: AppliedServerRunEntry[]) {
		this._appliedServersRecent = value;
	}

	public get appliedServersHistory(): AppliedServerRunEntry[] {
		return this._appliedServersHistory;
	}
	public set appliedServersHistory(value: AppliedServerRunEntry[]) {
		this._appliedServersHistory = value;
	}

	public get meta(): BanMeta {
		return this._meta;
	}
	public set meta(value: BanMeta) {
		this._meta = value;
	}

	private _id!: string;
	private _collectionId!: string;
	private _userId!: string;
	private _moderatorId!: string;
	private _moderatorGuildId!: string;
	private _timestamp!: string;
	private _expiresAt!: string | null;
	private _reason!: string | null;
	private _userFacingReason!: string | null;
	private _privatiseReason!: boolean;
	private _moderatorsInvolved!: string[];
	private _evidence!: EvidenceEntry[];
	private _active!: boolean;
	private _appliedServersRecent!: AppliedServerRunEntry[];
	private _appliedServersHistory!: AppliedServerRunEntry[];
	private _meta!: BanMeta;

	public constructor(id: string) {
		const db = connectDb();
		const row = db.prepare<unknown[], BanRow>('SELECT * FROM bans WHERE _id = ?').get(id);
		if (!row) throw new RecordNotFoundError(`Ban not found: ${id}`);
		this.applyRow(row);
	}

	public applyRow(row: BanRow) {
		this._id = row._id;
		this._collectionId = row.collectionId;
		this._userId = row.userId;
		this._moderatorId = row.moderatorId;
		this._moderatorGuildId = row.moderatorGuildId;
		this._timestamp = row.timestamp;
		this._expiresAt = row.expiresAt;
		this._reason = row.reason;
		this._userFacingReason = row.userFacingReason;
		this._privatiseReason = fromDbBool(row.privatiseReason);
		this._moderatorsInvolved = parseJson<string[]>(row.moderatorsInvolvedJson, []);
		this._evidence = parseJson<EvidenceEntry[]>(row.evidenceJson, []);
		this._active = fromDbBool(row.active);
		this._appliedServersRecent = parseJson<AppliedServerRunEntry[]>(row.appliedServersRecentJson, []);
		this._appliedServersHistory = parseJson<AppliedServerRunEntry[]>(row.appliedServersHistoryJson, []);
		this._meta = parseJson<BanMeta>(row.metaJson, {});
	}

	public static create(input: BanCreateInput): Ban {
		const db = connectDb();
		const id = newId();
		const timestamp = nowIso();

		const evidence = input.evidence ?? [];
		if (evidence.length > 5) throw new Error('evidence max 5 entries');

		db.prepare(
			`INSERT INTO bans (
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
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			id,
			input.collectionId,
			input.userId,
			input.moderatorId,
			input.moderatorGuildId,
			timestamp,
			input.expiresAt ?? null,
			input.reason ?? null,
			input.userFacingReason ?? input.reason ?? null,
			toDbBool(input.privatiseReason ?? true),
			stringifyJson(input.moderatorsInvolved ?? []),
			stringifyJson(evidence),
			toDbBool(input.active ?? true),
			stringifyJson(input.appliedServersRecent ?? []),
			stringifyJson(input.appliedServersHistory ?? []),
			stringifyJson(input.meta ?? { runs: 1 })
		);

		console.log(`[DB] Ban created: id=${id} userId=${input.userId} collectionId=${input.collectionId}`);

		return new Ban(id);
	}

	public static getById(id: string): Ban {
		return new Ban(id);
	}

	public static listByCollection(collectionId: string, onlyActive = false): Ban[] {
		const db = connectDb();
		const limit = 1000;
		if (onlyActive) {
			const rows = db
				.prepare<unknown[], BanRow>('SELECT * FROM bans WHERE collectionId = ? AND active = 1 ORDER BY timestamp DESC LIMIT ?')
				.all(collectionId, limit);
			return rows.map(hydrateBan);
		}

		const rows = db
			.prepare<unknown[], BanRow>('SELECT * FROM bans WHERE collectionId = ? ORDER BY timestamp DESC LIMIT ?')
			.all(collectionId, limit);
		return rows.map(hydrateBan);
	}

	public static findByUserId(userId: string, onlyActive = false): Ban[] {
		const db = connectDb();
		const limit = 500;
		if (onlyActive) {
			const rows = db
				.prepare<unknown[], BanRow>('SELECT * FROM bans WHERE userId = ? AND active = 1 ORDER BY timestamp DESC LIMIT ?')
				.all(userId, limit);
			return rows.map(hydrateBan);
		}

		const rows = db.prepare<unknown[], BanRow>('SELECT * FROM bans WHERE userId = ? ORDER BY timestamp DESC LIMIT ?').all(userId, limit);
		return rows.map(hydrateBan);
	}

	public static findByUsername(_username: string, onlyActive = false): Ban[] {
		// fetch bounded set for fuzzy matching, command layer handles username resolution
		const db = connectDb();
		const limit = 1000;
		if (onlyActive) {
			const rows = db.prepare<unknown[], BanRow>('SELECT * FROM bans WHERE active = 1 ORDER BY timestamp DESC LIMIT ?').all(limit);
			return rows.map(hydrateBan);
		}

		const rows = db.prepare<unknown[], BanRow>('SELECT * FROM bans ORDER BY timestamp DESC LIMIT ?').all(limit);
		return rows.map(hydrateBan);
	}

	public reload(): void {
		const db = connectDb();
		const row = db.prepare<unknown[], BanRow>('SELECT * FROM bans WHERE _id = ?').get(this._id);
		if (!row) throw new RecordNotFoundError(`Ban not found: ${this._id}`);
		this.applyRow(row);
	}

	public save(): void {
		const db = connectDb();
		const result = db
			.prepare(
				`UPDATE bans SET
					collectionId = ?,
					userId = ?,
					moderatorId = ?,
					moderatorGuildId = ?,
					expiresAt = ?,
					reason = ?,
					userFacingReason = ?,
					privatiseReason = ?,
					moderatorsInvolvedJson = ?,
					evidenceJson = ?,
					active = ?,
					appliedServersRecentJson = ?,
					appliedServersHistoryJson = ?,
					metaJson = ?
				WHERE _id = ?`
			)
			.run(
				this._collectionId,
				this._userId,
				this._moderatorId,
				this._moderatorGuildId,
				this._expiresAt,
				this._reason,
				this._userFacingReason,
				toDbBool(this._privatiseReason),
				stringifyJson(this._moderatorsInvolved),
				stringifyJson(this._evidence),
				toDbBool(this._active),
				stringifyJson(this._appliedServersRecent),
				stringifyJson(this._appliedServersHistory),
				stringifyJson(this._meta),
				this._id
			);

		if (result.changes === 0) throw new RecordNotFoundError(`Ban not found: ${this._id}`);
		console.log(`[DB] Ban saved: id=${this._id} userId=${this._userId} active=${this._active}`);
	}

	public revoke(): void {
		console.log(`[DB] Ban revoked: id=${this._id} userId=${this._userId}`);
		this._active = false;
		this.save();
	}

	public remove(): void {
		this.revoke();
	}
}
