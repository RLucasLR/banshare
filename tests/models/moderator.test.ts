import { describe, it, expect } from 'vitest';
import { Collection } from '../../src/database/models/collection';
import { Moderator } from '../../src/database/models/moderator';
import { RecordNotFoundError } from '../../src/database/models/shared';

function makeCollection(guildId = '111111111111111111') {
	return Collection.create({
		mainGuildId: guildId,
		name: 'Test',
		createdBy: '222222222222222222'
	});
}

describe('Moderator model', () => {
	describe('grant', () => {
		it('should grant a user moderator', () => {
			const col = makeCollection();
			const mod = Moderator.grant({
				collectionId: col.id,
				type: 'user',
				value: '333333333333333333',
				grantedBy: '222222222222222222'
			});

			expect(mod.id).toBeTruthy();
			expect(mod.collectionId).toBe(col.id);
			expect(mod.type).toBe('user');
			expect(mod.value).toBe('333333333333333333');
			expect(mod.grantedBy).toBe('222222222222222222');
			expect(mod.grantedAt).toBeTruthy();
		});

		it('should grant a role moderator', () => {
			const col = makeCollection();
			const mod = Moderator.grant({
				collectionId: col.id,
				type: 'role',
				value: '444444444444444444',
				grantedBy: '222222222222222222'
			});

			expect(mod.type).toBe('role');
			expect(mod.value).toBe('444444444444444444');
		});

		it('should enforce unique (collection, type, value)', () => {
			const col = makeCollection();
			Moderator.grant({ collectionId: col.id, type: 'user', value: '333', grantedBy: '222' });
			expect(() => Moderator.grant({ collectionId: col.id, type: 'user', value: '333', grantedBy: '222' })).toThrow();
		});

		it('should allow same value with different type', () => {
			const col = makeCollection();
			Moderator.grant({ collectionId: col.id, type: 'user', value: '333', grantedBy: '222' });
			const roleMod = Moderator.grant({ collectionId: col.id, type: 'role', value: '333', grantedBy: '222' });
			expect(roleMod.type).toBe('role');
		});
	});

	describe('getById', () => {
		it('should fetch an existing moderator', () => {
			const col = makeCollection();
			const mod = Moderator.grant({ collectionId: col.id, type: 'user', value: '333', grantedBy: '222' });
			const fetched = Moderator.getById(mod.id);
			expect(fetched.value).toBe('333');
		});

		it('should throw for missing id', () => {
			expect(() => Moderator.getById('nonexistent')).toThrow(RecordNotFoundError);
		});
	});

	describe('getByCollectionTypeValue', () => {
		it('should find by composite key', () => {
			const col = makeCollection();
			Moderator.grant({ collectionId: col.id, type: 'user', value: '333', grantedBy: '222' });
			const fetched = Moderator.getByCollectionTypeValue(col.id, 'user', '333');
			expect(fetched.value).toBe('333');
		});

		it('should throw if not found', () => {
			const col = makeCollection();
			expect(() => Moderator.getByCollectionTypeValue(col.id, 'user', '999')).toThrow(RecordNotFoundError);
		});
	});

	describe('listByCollection', () => {
		it('should return all moderators for a collection', () => {
			const col = makeCollection();
			Moderator.grant({ collectionId: col.id, type: 'user', value: '333', grantedBy: '222' });
			Moderator.grant({ collectionId: col.id, type: 'role', value: '444', grantedBy: '222' });
			Moderator.grant({ collectionId: col.id, type: 'user', value: '555', grantedBy: '222' });

			const mods = Moderator.listByCollection(col.id);
			expect(mods).toHaveLength(3);
		});

		it('should return empty for collection with no moderators', () => {
			const col = makeCollection();
			expect(Moderator.listByCollection(col.id)).toEqual([]);
		});

		it('should not return moderators from other collections', () => {
			const col1 = makeCollection('100');
			const col2 = makeCollection('200');
			Moderator.grant({ collectionId: col1.id, type: 'user', value: '333', grantedBy: '222' });
			Moderator.grant({ collectionId: col2.id, type: 'user', value: '444', grantedBy: '222' });

			expect(Moderator.listByCollection(col1.id)).toHaveLength(1);
			expect(Moderator.listByCollection(col2.id)).toHaveLength(1);
		});
	});

	describe('save', () => {
		it('should persist changes', () => {
			const col = makeCollection();
			const mod = Moderator.grant({ collectionId: col.id, type: 'user', value: '333', grantedBy: '222' });
			mod.value = '666';
			mod.save();

			const fetched = Moderator.getById(mod.id);
			expect(fetched.value).toBe('666');
		});

		it('should throw if moderator was deleted', () => {
			const col = makeCollection();
			const mod = Moderator.grant({ collectionId: col.id, type: 'user', value: '333', grantedBy: '222' });
			mod.remove();
			mod.value = 'ghost';
			expect(() => mod.save()).toThrow(RecordNotFoundError);
		});
	});

	describe('remove', () => {
		it('should hard-delete the moderator', () => {
			const col = makeCollection();
			const mod = Moderator.grant({ collectionId: col.id, type: 'user', value: '333', grantedBy: '222' });
			const id = mod.id;
			mod.remove();
			expect(() => Moderator.getById(id)).toThrow(RecordNotFoundError);
		});

		it('should throw if already removed', () => {
			const col = makeCollection();
			const mod = Moderator.grant({ collectionId: col.id, type: 'user', value: '333', grantedBy: '222' });
			mod.remove();
			expect(() => mod.remove()).toThrow(RecordNotFoundError);
		});
	});

	describe('reload', () => {
		it('should refresh from database', () => {
			const col = makeCollection();
			const mod = Moderator.grant({ collectionId: col.id, type: 'user', value: '333', grantedBy: '222' });
			const other = Moderator.getById(mod.id);
			other.value = '777';
			other.save();

			mod.reload();
			expect(mod.value).toBe('777');
		});
	});
});
