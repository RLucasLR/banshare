import { connectDb } from '../main';
import { fromDbBool, newId, nowIso, RecordNotFoundError, toDbBool } from './shared';

export type OnServerRemovePolicy = 'retain' | 'lift' | 'archive';

export interface CollectionCreateInput {
	mainGuildId: string;
	name: string;
	description?: string | null;
	createdBy: string;
	loggingEnabledAtCollectionLevel?: boolean;
	onServerRemove?: OnServerRemovePolicy;
	dmOnBan?: boolean;
	analyticsEnabled?: boolean;
	maxLinkedServers?: number;
}

interface CollectionRow {
	_id: string;
	mainGuildId: string;
	name: string;
	description: string | null;
	createdAt: string;
	createdBy: string;
	loggingEnabledAtCollectionLevel: 0 | 1;
	onServerRemove: OnServerRemovePolicy;
	dmOnBan: 0 | 1;
	analyticsEnabled: 0 | 1;
	maxLinkedServers: number;
}

const hydrateCollection = (row: CollectionRow): Collection => {
	const instance = Object.create(Collection.prototype) as Collection;
	instance.applyRow(row);
	return instance;
};

export class Collection {
	public get id(): string {
		return this._id;
	}

	public get mainGuildId(): string {
		return this._mainGuildId;
	}
	public set mainGuildId(value: string) {
		this._mainGuildId = value;
	}

	public get name(): string {
		return this._name;
	}
	public set name(value: string) {
		this._name = value;
	}

	public get description(): string | null {
		return this._description;
	}
	public set description(value: string | null) {
		this._description = value;
	}

	public get createdAt(): string {
		return this._createdAt;
	}

	public get createdBy(): string {
		return this._createdBy;
	}

	public get loggingEnabledAtCollectionLevel(): boolean {
		return this._loggingEnabledAtCollectionLevel;
	}
	public set loggingEnabledAtCollectionLevel(value: boolean) {
		this._loggingEnabledAtCollectionLevel = value;
	}

	public get onServerRemove(): OnServerRemovePolicy {
		return this._onServerRemove;
	}
	public set onServerRemove(value: OnServerRemovePolicy) {
		this._onServerRemove = value;
	}

	public get dmOnBan(): boolean {
		return this._dmOnBan;
	}
	public set dmOnBan(value: boolean) {
		this._dmOnBan = value;
	}

	public get analyticsEnabled(): boolean {
		return this._analyticsEnabled;
	}
	public set analyticsEnabled(value: boolean) {
		this._analyticsEnabled = value;
	}

	public get maxLinkedServers(): number {
		return this._maxLinkedServers;
	}
	public set maxLinkedServers(value: number) {
		if (!Number.isFinite(value) || value <= 0) {
			throw new Error('maxLinkedServers must be a positive number');
		}
		this._maxLinkedServers = value;
	}

	private _id!: string;
	private _mainGuildId!: string;
	private _name!: string;
	private _description!: string | null;
	private _createdAt!: string;
	private _createdBy!: string;
	private _loggingEnabledAtCollectionLevel!: boolean;
	private _onServerRemove!: OnServerRemovePolicy;
	private _dmOnBan!: boolean;
	private _analyticsEnabled!: boolean;
	private _maxLinkedServers!: number;

	public constructor(id: string) {
		const db = connectDb();
		const row = db.prepare<unknown[], CollectionRow>('SELECT * FROM collections WHERE _id = ?').get(id);

		if (!row) throw new RecordNotFoundError(`Collection not found: ${id}`);
		this.applyRow(row);
	}

	public applyRow(row: CollectionRow) {
		this._id = row._id;
		this._mainGuildId = row.mainGuildId;
		this._name = row.name;
		this._description = row.description;
		this._createdAt = row.createdAt;
		this._createdBy = row.createdBy;
		this._loggingEnabledAtCollectionLevel = fromDbBool(row.loggingEnabledAtCollectionLevel);
		this._onServerRemove = row.onServerRemove;
		this._dmOnBan = fromDbBool(row.dmOnBan);
		this._analyticsEnabled = fromDbBool(row.analyticsEnabled);
		this._maxLinkedServers = row.maxLinkedServers;
	}

	public static create(input: CollectionCreateInput): Collection {
		const db = connectDb();

		const id = newId();
		const createdAt = nowIso();

		const maxLinkedServers = input.maxLinkedServers ?? 30;
		if (!Number.isFinite(maxLinkedServers) || maxLinkedServers <= 0) {
			throw new Error('maxLinkedServers must be a positive number');
		}

		db.prepare(
			`INSERT INTO collections (
				_id,
				mainGuildId,
				name,
				description,
				createdAt,
				createdBy,
				loggingEnabledAtCollectionLevel,
				onServerRemove,
				dmOnBan,
				analyticsEnabled,
				maxLinkedServers
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		).run(
			id,
			input.mainGuildId,
			input.name,
			input.description ?? null,
			createdAt,
			input.createdBy,
			toDbBool(input.loggingEnabledAtCollectionLevel ?? true),
			input.onServerRemove ?? 'retain',
			toDbBool(input.dmOnBan ?? false),
			toDbBool(input.analyticsEnabled ?? false),
			maxLinkedServers
		);

		console.log(`[DB] Collection created: id=${id} name="${input.name}" mainGuildId=${input.mainGuildId}`);

		return new Collection(id);
	}

	public static getById(id: string): Collection {
		return new Collection(id);
	}

	public static getByMainGuildId(mainGuildId: string): Collection {
		const db = connectDb();
		const row = db.prepare<unknown[], Pick<CollectionRow, '_id'>>('SELECT _id FROM collections WHERE mainGuildId = ?').get(mainGuildId);
		if (!row) throw new RecordNotFoundError(`Collection not found for mainGuildId: ${mainGuildId}`);
		return new Collection(row._id);
	}

	public static listAll(): Collection[] {
		const db = connectDb();
		const rows = db.prepare<unknown[], CollectionRow>('SELECT * FROM collections ORDER BY createdAt DESC LIMIT 500').all();
		return rows.map(hydrateCollection);
	}

	public reload(): void {
		const db = connectDb();
		const row = db.prepare<unknown[], CollectionRow>('SELECT * FROM collections WHERE _id = ?').get(this._id);
		if (!row) throw new RecordNotFoundError(`Collection not found: ${this._id}`);
		this.applyRow(row);
	}

	public save(): void {
		const db = connectDb();
		const result = db
			.prepare(
				`UPDATE collections SET
					mainGuildId = ?,
					name = ?,
					description = ?,
					loggingEnabledAtCollectionLevel = ?,
					onServerRemove = ?,
					dmOnBan = ?,
					analyticsEnabled = ?,
					maxLinkedServers = ?
				WHERE _id = ?`
			)
			.run(
				this._mainGuildId,
				this._name,
				this._description,
				toDbBool(this._loggingEnabledAtCollectionLevel),
				this._onServerRemove,
				toDbBool(this._dmOnBan),
				toDbBool(this._analyticsEnabled),
				this._maxLinkedServers,
				this._id
			);

		if (result.changes === 0) throw new RecordNotFoundError(`Collection not found: ${this._id}`);
		console.log(`[DB] Collection saved: id=${this._id} name="${this._name}"`);
	}

	public remove(): void {
		const db = connectDb();

		const tx = db.transaction(() => {
			db.prepare('DELETE FROM auditLogs WHERE collectionId = ?').run(this._id);
			db.prepare('DELETE FROM moderators WHERE collectionId = ?').run(this._id);
			db.prepare('DELETE FROM bans WHERE collectionId = ?').run(this._id);
			db.prepare('DELETE FROM servers WHERE collectionId = ?').run(this._id);
			const result = db.prepare('DELETE FROM collections WHERE _id = ?').run(this._id);
			if (result.changes === 0) throw new RecordNotFoundError(`Collection not found: ${this._id}`);
		});

		tx();
		console.log(`[DB] Collection removed (cascade): id=${this._id}`);
	}
}
