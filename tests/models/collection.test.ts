import { describe, it, expect } from 'vitest';
import { Collection } from '../../src/database/models/collection';
import { RecordNotFoundError } from '../../src/database/models/shared';

describe('Collection model', () => {
	const baseInput = {
		mainGuildId: '111111111111111111',
		name: 'Test Collection',
		createdBy: '222222222222222222'
	};

	describe('create', () => {
		it('should create a collection with defaults', () => {
			const col = Collection.create(baseInput);

			expect(col.id).toBeTruthy();
			expect(col.mainGuildId).toBe(baseInput.mainGuildId);
			expect(col.name).toBe(baseInput.name);
			expect(col.description).toBeNull();
			expect(col.createdBy).toBe(baseInput.createdBy);
			expect(col.createdAt).toBeTruthy();
			// defaults
			expect(col.loggingEnabledAtCollectionLevel).toBe(true);
			expect(col.onServerRemove).toBe('retain');
			expect(col.dmOnBan).toBe(false);
			expect(col.analyticsEnabled).toBe(false);
			expect(col.requireEvidence).toBe(false);
			expect(col.allowExpiry).toBe(true);
			expect(col.maxLinkedServers).toBe(30);
		});

		it('should create a collection with custom options', () => {
			const col = Collection.create({
				...baseInput,
				description: 'A test collection',
				loggingEnabledAtCollectionLevel: false,
				onServerRemove: 'lift',
				dmOnBan: true,
				analyticsEnabled: true,
				requireEvidence: true,
				allowExpiry: false,
				maxLinkedServers: 50
			});

			expect(col.description).toBe('A test collection');
			expect(col.loggingEnabledAtCollectionLevel).toBe(false);
			expect(col.onServerRemove).toBe('lift');
			expect(col.dmOnBan).toBe(true);
			expect(col.analyticsEnabled).toBe(true);
			expect(col.requireEvidence).toBe(true);
			expect(col.allowExpiry).toBe(false);
			expect(col.maxLinkedServers).toBe(50);
		});

		it('should reject invalid maxLinkedServers', () => {
			expect(() => Collection.create({ ...baseInput, maxLinkedServers: 0 })).toThrow('maxLinkedServers must be a positive number');
			expect(() => Collection.create({ ...baseInput, maxLinkedServers: -5 })).toThrow('maxLinkedServers must be a positive number');
			expect(() => Collection.create({ ...baseInput, maxLinkedServers: Infinity })).toThrow('maxLinkedServers must be a positive number');
		});

		it('should enforce unique mainGuildId', () => {
			Collection.create(baseInput);
			expect(() => Collection.create(baseInput)).toThrow(); // UNIQUE constraint
		});
	});

	describe('getById', () => {
		it('should fetch an existing collection', () => {
			const created = Collection.create(baseInput);
			const fetched = Collection.getById(created.id);
			expect(fetched.name).toBe(baseInput.name);
			expect(fetched.id).toBe(created.id);
		});

		it('should throw RecordNotFoundError for missing id', () => {
			expect(() => Collection.getById('nonexistent-id')).toThrow(RecordNotFoundError);
		});
	});

	describe('getByMainGuildId', () => {
		it('should fetch by guild id', () => {
			const created = Collection.create(baseInput);
			const fetched = Collection.getByMainGuildId(baseInput.mainGuildId);
			expect(fetched.id).toBe(created.id);
		});

		it('should throw for unknown guild id', () => {
			expect(() => Collection.getByMainGuildId('999')).toThrow(RecordNotFoundError);
		});
	});

	describe('listAll', () => {
		it('should return empty array when no collections', () => {
			expect(Collection.listAll()).toEqual([]);
		});

		it('should return all collections', () => {
			Collection.create({ ...baseInput, mainGuildId: '100' });
			Collection.create({ ...baseInput, mainGuildId: '200', name: 'Second' });

			const all = Collection.listAll();
			expect(all).toHaveLength(2);
			const names = all.map((c) => c.name);
			expect(names).toContain('Test Collection');
			expect(names).toContain('Second');
		});
	});

	describe('save', () => {
		it('should persist changes', () => {
			const col = Collection.create(baseInput);
			col.name = 'Updated Name';
			col.description = 'New description';
			col.dmOnBan = true;
			col.onServerRemove = 'archive';
			col.maxLinkedServers = 10;
			col.save();

			const fetched = Collection.getById(col.id);
			expect(fetched.name).toBe('Updated Name');
			expect(fetched.description).toBe('New description');
			expect(fetched.dmOnBan).toBe(true);
			expect(fetched.onServerRemove).toBe('archive');
			expect(fetched.maxLinkedServers).toBe(10);
		});

		it('should throw if collection was deleted', () => {
			const col = Collection.create(baseInput);
			col.remove();
			// After removal, save should fail
			col.name = 'Ghost';
			expect(() => col.save()).toThrow(RecordNotFoundError);
		});
	});

	describe('reload', () => {
		it('should refresh data from database', () => {
			const col = Collection.create(baseInput);
			const other = Collection.getById(col.id);
			other.name = 'Changed externally';
			other.save();

			col.reload();
			expect(col.name).toBe('Changed externally');
		});

		it('should throw if collection was deleted', () => {
			const col = Collection.create(baseInput);
			col.remove();
			expect(() => col.reload()).toThrow(RecordNotFoundError);
		});
	});

	describe('remove', () => {
		it('should delete the collection and cascade', () => {
			const col = Collection.create(baseInput);
			const id = col.id;
			col.remove();
			expect(() => Collection.getById(id)).toThrow(RecordNotFoundError);
		});

		it('should throw if collection already removed', () => {
			const col = Collection.create(baseInput);
			col.remove();
			expect(() => col.remove()).toThrow(RecordNotFoundError);
		});
	});

	describe('maxLinkedServers setter', () => {
		it('should reject invalid values via setter', () => {
			const col = Collection.create(baseInput);
			expect(() => { col.maxLinkedServers = 0; }).toThrow('maxLinkedServers must be a positive number');
			expect(() => { col.maxLinkedServers = -1; }).toThrow('maxLinkedServers must be a positive number');
			expect(() => { col.maxLinkedServers = Infinity; }).toThrow('maxLinkedServers must be a positive number');
			expect(() => { col.maxLinkedServers = NaN; }).toThrow('maxLinkedServers must be a positive number');
		});

		it('should accept valid values via setter', () => {
			const col = Collection.create(baseInput);
			col.maxLinkedServers = 5;
			expect(col.maxLinkedServers).toBe(5);
		});
	});
});
