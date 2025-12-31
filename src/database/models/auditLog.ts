import { connectDb } from '../main';
import { newId, nowIso, parseJson, RecordNotFoundError, stringifyJson } from './shared';

export type AuditLogAction =
	| 'collection.create'
	| 'collection.create.failed'
	| 'server.add'
	| 'server.add.failed'
	| 'server.remove'
	| 'server.remove.failed'
	| 'moderator.add'
	| 'moderator.add.failed'
	| 'moderator.remove'
	| 'moderator.remove.failed'
	| 'ban.create'
	| 'ban.create.failed'
	| 'ban.revoke'
	| 'ban.revoke.failed'
	| 'ban.sync'
	| 'ban.sync.failed'
	| 'ban.edit'
	| 'ban.edit.failed'
	| 'ban.lookup'
	| 'ban.view'
	| 'setting.update'
	| 'setting.update.failed'
	| 'invite.create'
	| 'invite.create.failed'
	| 'invite.accept'
	| 'invite.accept.failed'
	| 'collection.delete'
	| 'collection.delete.failed'
	| 'evidence.access';

export interface AuditLogCreateInput {
	collectionId: string;
	action: AuditLogAction;
	performedBy: string;
	details?: unknown;
}

interface AuditLogRow {
	_id: string;
	collectionId: string;
	action: AuditLogAction;
	performedBy: string;
	performedAt: string;
	detailsJson: string;
}

const hydrateAuditLog = (row: AuditLogRow): AuditLog => {
	const instance = Object.create(AuditLog.prototype) as AuditLog;
	instance.applyRow(row);
	return instance;
};

export class AuditLog {
	public get id(): string {
		return this._id;
	}

	public get collectionId(): string {
		return this._collectionId;
	}
	public set collectionId(value: string) {
		this._collectionId = value;
	}

	public get action(): AuditLogAction {
		return this._action;
	}
	public set action(value: AuditLogAction) {
		this._action = value;
	}

	public get performedBy(): string {
		return this._performedBy;
	}

	public get performedAt(): string {
		return this._performedAt;
	}

	public get details(): unknown {
		return this._details;
	}
	public set details(value: unknown) {
		this._details = value;
	}

	private _id!: string;
	private _collectionId!: string;
	private _action!: AuditLogAction;
	private _performedBy!: string;
	private _performedAt!: string;
	private _details!: unknown;

	public constructor(id: string) {
		const db = connectDb();
		const row = db.prepare<unknown[], AuditLogRow>('SELECT * FROM auditLogs WHERE _id = ?').get(id);
		if (!row) throw new RecordNotFoundError(`AuditLog not found: ${id}`);
		this.applyRow(row);
	}

	public applyRow(row: AuditLogRow) {
		this._id = row._id;
		this._collectionId = row.collectionId;
		this._action = row.action;
		this._performedBy = row.performedBy;
		this._performedAt = row.performedAt;
		this._details = parseJson(row.detailsJson, {});
	}

	public static create(input: AuditLogCreateInput): AuditLog {
		const db = connectDb();
		const id = newId();
		db.prepare(
			`INSERT INTO auditLogs (
				_id,
				collectionId,
				action,
				performedBy,
				performedAt,
				detailsJson
			) VALUES (?, ?, ?, ?, ?, ?)`
		).run(id, input.collectionId, input.action, input.performedBy, nowIso(), stringifyJson(input.details ?? {}));

		console.log(`[DB] AuditLog created: id=${id} action=${input.action} collectionId=${input.collectionId}`);

		return new AuditLog(id);
	}

	public static getById(id: string): AuditLog {
		return new AuditLog(id);
	}

	public static listByCollection(collectionId: string, limit = 100): AuditLog[] {
		const db = connectDb();
		const cappedLimit = Math.min(limit, 500);
		const rows = db
			.prepare<unknown[], AuditLogRow>('SELECT * FROM auditLogs WHERE collectionId = ? ORDER BY performedAt DESC LIMIT ?')
			.all(collectionId, cappedLimit);
		return rows.map(hydrateAuditLog);
	}

	public reload(): void {
		const db = connectDb();
		const row = db.prepare<unknown[], AuditLogRow>('SELECT * FROM auditLogs WHERE _id = ?').get(this._id);
		if (!row) throw new RecordNotFoundError(`AuditLog not found: ${this._id}`);
		this.applyRow(row);
	}

	public save(): void {
		const db = connectDb();
		const result = db
			.prepare(
				`UPDATE auditLogs SET
					collectionId = ?,
					action = ?,
					detailsJson = ?
				WHERE _id = ?`
			)
			.run(this._collectionId, this._action, stringifyJson(this._details), this._id);

		if (result.changes === 0) throw new RecordNotFoundError(`AuditLog not found: ${this._id}`);
		console.log(`[DB] AuditLog saved: id=${this._id} action=${this._action}`);
	}

	public remove(): void {
		const db = connectDb();
		const result = db.prepare('DELETE FROM auditLogs WHERE _id = ?').run(this._id);
		if (result.changes === 0) throw new RecordNotFoundError(`AuditLog not found: ${this._id}`);
		console.log(`[DB] AuditLog removed: id=${this._id} action=${this._action}`);
	}
}
