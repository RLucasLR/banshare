import { connectDb } from '../main';
import { fromDbBool, newId, nowIso, RecordNotFoundError, toDbBool } from './shared';

export interface ServerAddInput {
	guildId: string;
	collectionId: string;
	addedBy: string;
	loggingChannelId?: string | null;
	syncOnJoin?: boolean;
	enabled?: boolean;
}

interface ServerRow {
	_id: string;
	guildId: string;
	collectionId: string;
	addedAt: string;
	addedBy: string;
	loggingChannelId: string | null;
	syncOnJoin: 0 | 1;
	enabled: 0 | 1;
}

const hydrateServer = (row: ServerRow): Server => {
	const instance = Object.create(Server.prototype) as Server;
	instance.applyRow(row);
	return instance;
};

export class Server {
	public get id(): string {
		return this._id;
	}

	public get guildId(): string {
		return this._guildId;
	}
	public set guildId(value: string) {
		this._guildId = value;
	}

	public get collectionId(): string {
		return this._collectionId;
	}
	public set collectionId(value: string) {
		this._collectionId = value;
	}

	public get addedAt(): string {
		return this._addedAt;
	}

	public get addedBy(): string {
		return this._addedBy;
	}

	public get loggingChannelId(): string | null {
		return this._loggingChannelId;
	}
	public set loggingChannelId(value: string | null) {
		this._loggingChannelId = value;
	}

	public get syncOnJoin(): boolean {
		return this._syncOnJoin;
	}
	public set syncOnJoin(value: boolean) {
		this._syncOnJoin = value;
	}

	public get enabled(): boolean {
		return this._enabled;
	}
	public set enabled(value: boolean) {
		this._enabled = value;
	}

	private _id!: string;
	private _guildId!: string;
	private _collectionId!: string;
	private _addedAt!: string;
	private _addedBy!: string;
	private _loggingChannelId!: string | null;
	private _syncOnJoin!: boolean;
	private _enabled!: boolean;

	public constructor(id: string) {
		const db = connectDb();
		const row = db.prepare<unknown[], ServerRow>('SELECT * FROM servers WHERE _id = ?').get(id);
		if (!row) throw new RecordNotFoundError(`Server not found: ${id}`);
		this.applyRow(row);
	}

	public applyRow(row: ServerRow) {
		this._id = row._id;
		this._guildId = row.guildId;
		this._collectionId = row.collectionId;
		this._addedAt = row.addedAt;
		this._addedBy = row.addedBy;
		this._loggingChannelId = row.loggingChannelId;
		this._syncOnJoin = fromDbBool(row.syncOnJoin);
		this._enabled = fromDbBool(row.enabled);
	}

	public static add(input: ServerAddInput): Server {
		const db = connectDb();
		const id = newId();

		db.prepare(
			`INSERT INTO servers (
				_id,
				guildId,
				collectionId,
				addedAt,
				addedBy,
				loggingChannelId,
				syncOnJoin,
				enabled
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			id,
			input.guildId,
			input.collectionId,
			nowIso(),
			input.addedBy,
			input.loggingChannelId ?? null,
			toDbBool(input.syncOnJoin ?? true),
			toDbBool(input.enabled ?? true)
		);

		console.log(`[DB] Server added: id=${id} guildId=${input.guildId} collectionId=${input.collectionId}`);

		return new Server(id);
	}

	public static getById(id: string): Server {
		return new Server(id);
	}

	public static listByCollection(collectionId: string): Server[] {
		const db = connectDb();
		const rows = db.prepare<unknown[], ServerRow>('SELECT * FROM servers WHERE collectionId = ? ORDER BY addedAt DESC').all(collectionId);
		return rows.map(hydrateServer);
	}

	public static getByCollectionAndGuild(collectionId: string, guildId: string): Server {
		const db = connectDb();
		const row = db
			.prepare<unknown[], Pick<ServerRow, '_id'>>('SELECT _id FROM servers WHERE collectionId = ? AND guildId = ?')
			.get(collectionId, guildId);
		if (!row) throw new RecordNotFoundError(`Server not found for collectionId=${collectionId} guildId=${guildId}`);
		return new Server(row._id);
	}

	public static getByGuildId(guildId: string): Server {
		const db = connectDb();
		const row = db.prepare<unknown[], Pick<ServerRow, '_id'>>('SELECT _id FROM servers WHERE guildId = ? AND enabled = 1').get(guildId);
		if (!row) throw new RecordNotFoundError(`Server not found for guildId=${guildId}`);
		return new Server(row._id);
	}

	public reload(): void {
		const db = connectDb();
		const row = db.prepare<unknown[], ServerRow>('SELECT * FROM servers WHERE _id = ?').get(this._id);
		if (!row) throw new RecordNotFoundError(`Server not found: ${this._id}`);
		this.applyRow(row);
	}

	public save(): void {
		const db = connectDb();
		const result = db
			.prepare(
				`UPDATE servers SET
					guildId = ?,
					collectionId = ?,
					loggingChannelId = ?,
					syncOnJoin = ?,
					enabled = ?
				WHERE _id = ?`
			)
			.run(this._guildId, this._collectionId, this._loggingChannelId, toDbBool(this._syncOnJoin), toDbBool(this._enabled), this._id);

		if (result.changes === 0) throw new RecordNotFoundError(`Server not found: ${this._id}`);
		console.log(`[DB] Server saved: id=${this._id} guildId=${this._guildId} enabled=${this._enabled}`);
	}

	public remove(): void {
		console.log(`[DB] Server removed (soft-delete): id=${this._id} guildId=${this._guildId}`);
		this._enabled = false;
		this.save();
	}
}
