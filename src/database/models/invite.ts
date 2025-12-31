import { connectDb } from '../main';
import { newId, nowIso, RecordNotFoundError } from './shared';

export type InviteStatus = 'pending' | 'accepted' | 'expired' | 'cancelled';

export interface InviteCreateInput {
	collectionId: string;
	targetGuildId: string;
	invitedBy: string;
}

interface InviteRow {
	_id: string;
	collectionId: string;
	targetGuildId: string;
	invitedBy: string;
	invitedAt: string;
	expiresAt: string;
	status: InviteStatus;
	respondedAt: string | null;
}

const hydrateInvite = (row: InviteRow): Invite => {
	const instance = Object.create(Invite.prototype) as Invite;
	instance.applyRow(row);
	return instance;
};

export class Invite {
	public get id(): string {
		return this._id;
	}

	public get collectionId(): string {
		return this._collectionId;
	}

	public get targetGuildId(): string {
		return this._targetGuildId;
	}

	public get invitedBy(): string {
		return this._invitedBy;
	}

	public get invitedAt(): string {
		return this._invitedAt;
	}

	public get expiresAt(): string {
		return this._expiresAt;
	}

	public get status(): InviteStatus {
		return this._status;
	}
	public set status(value: InviteStatus) {
		this._status = value;
	}

	public get respondedAt(): string | null {
		return this._respondedAt;
	}
	public set respondedAt(value: string | null) {
		this._respondedAt = value;
	}

	private _id!: string;
	private _collectionId!: string;
	private _targetGuildId!: string;
	private _invitedBy!: string;
	private _invitedAt!: string;
	private _expiresAt!: string;
	private _status!: InviteStatus;
	private _respondedAt!: string | null;

	public constructor(id: string) {
		const db = connectDb();
		const row = db.prepare<unknown[], InviteRow>('SELECT * FROM invites WHERE _id = ?').get(id);
		if (!row) throw new RecordNotFoundError(`Invite not found: ${id}`);
		this.applyRow(row);
	}

	public applyRow(row: InviteRow) {
		this._id = row._id;
		this._collectionId = row.collectionId;
		this._targetGuildId = row.targetGuildId;
		this._invitedBy = row.invitedBy;
		this._invitedAt = row.invitedAt;
		this._expiresAt = row.expiresAt;
		this._status = row.status;
		this._respondedAt = row.respondedAt;
	}

	public static create(input: InviteCreateInput): Invite {
		const db = connectDb();
		const id = newId();
		const now = nowIso();
		// 48 hours from now
		const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

		db.prepare(
			`INSERT INTO invites (
				_id,
				collectionId,
				targetGuildId,
				invitedBy,
				invitedAt,
				expiresAt,
				status,
				respondedAt
			) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL)`
		).run(id, input.collectionId, input.targetGuildId, input.invitedBy, now, expiresAt);

		console.log(`[DB] Invite created: id=${id} collectionId=${input.collectionId} targetGuildId=${input.targetGuildId}`);

		return new Invite(id);
	}

	public static getById(id: string): Invite {
		return new Invite(id);
	}

	public static getPendingForGuild(targetGuildId: string): Invite | null {
		const db = connectDb();
		const now = nowIso();
		const row = db
			.prepare<unknown[], InviteRow>(
				`SELECT * FROM invites 
				WHERE targetGuildId = ? 
				AND status = 'pending' 
				AND expiresAt > ?
				ORDER BY invitedAt DESC
				LIMIT 1`
			)
			.get(targetGuildId, now);
		return row ? hydrateInvite(row) : null;
	}

	public static listPendingForGuild(targetGuildId: string): Invite[] {
		const db = connectDb();
		const now = nowIso();
		const rows = db
			.prepare<unknown[], InviteRow>(
				`SELECT * FROM invites 
				WHERE targetGuildId = ? 
				AND status = 'pending' 
				AND expiresAt > ?
				ORDER BY invitedAt DESC`
			)
			.all(targetGuildId, now);
		return rows.map(hydrateInvite);
	}

	public static listByCollection(collectionId: string): Invite[] {
		const db = connectDb();
		const rows = db
			.prepare<unknown[], InviteRow>('SELECT * FROM invites WHERE collectionId = ? ORDER BY invitedAt DESC LIMIT 500')
			.all(collectionId);
		return rows.map(hydrateInvite);
	}

	public static hasPendingInvite(collectionId: string, targetGuildId: string): boolean {
		const db = connectDb();
		const now = nowIso();
		const row = db
			.prepare<unknown[], { count: number }>(
				`SELECT COUNT(*) as count FROM invites 
				WHERE collectionId = ? 
				AND targetGuildId = ? 
				AND status = 'pending' 
				AND expiresAt > ?`
			)
			.get(collectionId, targetGuildId, now);
		return (row?.count ?? 0) > 0;
	}

	public isExpired(): boolean {
		return new Date(this._expiresAt) < new Date();
	}

	public reload(): void {
		const db = connectDb();
		const row = db.prepare<unknown[], InviteRow>('SELECT * FROM invites WHERE _id = ?').get(this._id);
		if (!row) throw new RecordNotFoundError(`Invite not found: ${this._id}`);
		this.applyRow(row);
	}

	public save(): void {
		const db = connectDb();
		const result = db
			.prepare(
				`UPDATE invites SET
					status = ?,
					respondedAt = ?
				WHERE _id = ?`
			)
			.run(this._status, this._respondedAt, this._id);

		if (result.changes === 0) throw new RecordNotFoundError(`Invite not found: ${this._id}`);
		console.log(`[DB] Invite saved: id=${this._id} status=${this._status}`);
	}

	public accept(): void {
		this._status = 'accepted';
		this._respondedAt = nowIso();
		this.save();
		console.log(`[DB] Invite accepted: id=${this._id}`);
	}

	public cancel(): void {
		this._status = 'cancelled';
		this._respondedAt = nowIso();
		this.save();
		console.log(`[DB] Invite cancelled: id=${this._id}`);
	}

	public expire(): void {
		this._status = 'expired';
		this._respondedAt = nowIso();
		this.save();
		console.log(`[DB] Invite expired: id=${this._id}`);
	}
}
