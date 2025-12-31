import { connectDb } from '../main';
import { newId, nowIso, RecordNotFoundError } from './shared';

export type ModeratorType = 'user' | 'role';

export interface ModeratorGrantInput {
	collectionId: string;
	type: ModeratorType;
	value: string;
	grantedBy: string;
}

interface ModeratorRow {
	_id: string;
	collectionId: string;
	type: ModeratorType;
	value: string;
	grantedBy: string;
	grantedAt: string;
}

const hydrateModerator = (row: ModeratorRow): Moderator => {
	const instance = Object.create(Moderator.prototype) as Moderator;
	instance.applyRow(row);
	return instance;
};

export class Moderator {
	public get id(): string {
		return this._id;
	}

	public get collectionId(): string {
		return this._collectionId;
	}
	public set collectionId(value: string) {
		this._collectionId = value;
	}

	public get type(): ModeratorType {
		return this._type;
	}
	public set type(value: ModeratorType) {
		this._type = value;
	}

	public get value(): string {
		return this._value;
	}
	public set value(value: string) {
		this._value = value;
	}

	public get grantedBy(): string {
		return this._grantedBy;
	}

	public get grantedAt(): string {
		return this._grantedAt;
	}

	private _id!: string;
	private _collectionId!: string;
	private _type!: ModeratorType;
	private _value!: string;
	private _grantedBy!: string;
	private _grantedAt!: string;

	public constructor(id: string) {
		const db = connectDb();
		const row = db.prepare<unknown[], ModeratorRow>('SELECT * FROM moderators WHERE _id = ?').get(id);
		if (!row) throw new RecordNotFoundError(`Moderator not found: ${id}`);
		this.applyRow(row);
	}

	public applyRow(row: ModeratorRow) {
		this._id = row._id;
		this._collectionId = row.collectionId;
		this._type = row.type;
		this._value = row.value;
		this._grantedBy = row.grantedBy;
		this._grantedAt = row.grantedAt;
	}

	public static grant(input: ModeratorGrantInput): Moderator {
		const db = connectDb();
		const id = newId();

		db.prepare(
			`INSERT INTO moderators (
				_id,
				collectionId,
				type,
				value,
				grantedBy,
				grantedAt
			) VALUES (?, ?, ?, ?, ?, ?)`
		).run(id, input.collectionId, input.type, input.value, input.grantedBy, nowIso());

		console.log(`[DB] Moderator granted: id=${id} type=${input.type} value=${input.value} collectionId=${input.collectionId}`);

		return new Moderator(id);
	}

	public static getById(id: string): Moderator {
		return new Moderator(id);
	}

	public static listByCollection(collectionId: string): Moderator[] {
		const db = connectDb();
		const rows = db
			.prepare<unknown[], ModeratorRow>('SELECT * FROM moderators WHERE collectionId = ? ORDER BY grantedAt DESC LIMIT 200')
			.all(collectionId);
		return rows.map(hydrateModerator);
	}

	public static getByCollectionTypeValue(collectionId: string, type: ModeratorType, value: string): Moderator {
		const db = connectDb();
		const row = db
			.prepare<unknown[], Pick<ModeratorRow, '_id'>>('SELECT _id FROM moderators WHERE collectionId = ? AND type = ? AND value = ?')
			.get(collectionId, type, value);
		if (!row) throw new RecordNotFoundError(`Moderator not found for collectionId=${collectionId} type=${type} value=${value}`);
		return new Moderator(row._id);
	}

	public reload(): void {
		const db = connectDb();
		const row = db.prepare<unknown[], ModeratorRow>('SELECT * FROM moderators WHERE _id = ?').get(this._id);
		if (!row) throw new RecordNotFoundError(`Moderator not found: ${this._id}`);
		this.applyRow(row);
	}

	public save(): void {
		const db = connectDb();
		const result = db
			.prepare(
				`UPDATE moderators SET
					collectionId = ?,
					type = ?,
					value = ?
				WHERE _id = ?`
			)
			.run(this._collectionId, this._type, this._value, this._id);

		if (result.changes === 0) throw new RecordNotFoundError(`Moderator not found: ${this._id}`);
		console.log(`[DB] Moderator saved: id=${this._id} type=${this._type} value=${this._value}`);
	}

	public remove(): void {
		const db = connectDb();
		const result = db.prepare('DELETE FROM moderators WHERE _id = ?').run(this._id);
		if (result.changes === 0) throw new RecordNotFoundError(`Moderator not found: ${this._id}`);
		console.log(`[DB] Moderator removed: id=${this._id} type=${this._type} value=${this._value}`);
	}
}
