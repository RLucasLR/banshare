import { describe, it, expect } from 'vitest';
import { Collection } from '../../src/database/models/collection';
import { Server } from '../../src/database/models/server';
import { RecordNotFoundError } from '../../src/database/models/shared';

function makeCollection(guildId = '111111111111111111') {
	return Collection.create({
		mainGuildId: guildId,
		name: 'Test',
		createdBy: '222222222222222222'
	});
}

describe('Server model', () => {
	describe('add', () => {
		it('should add a server with defaults', () => {
			const col = makeCollection();
			const server = Server.add({
				guildId: '333333333333333333',
				collectionId: col.id,
				addedBy: '444444444444444444'
			});

			expect(server.id).toBeTruthy();
			expect(server.guildId).toBe('333333333333333333');
			expect(server.collectionId).toBe(col.id);
			expect(server.addedBy).toBe('444444444444444444');
			expect(server.addedAt).toBeTruthy();
			expect(server.loggingChannelId).toBeNull();
			expect(server.syncOnJoin).toBe(true);
			expect(server.enabled).toBe(true);
		});

		it('should add a server with custom options', () => {
			const col = makeCollection();
			const server = Server.add({
				guildId: '333333333333333333',
				collectionId: col.id,
				addedBy: '444444444444444444',
				loggingChannelId: '555555555555555555',
				syncOnJoin: false,
				enabled: false
			});

			expect(server.loggingChannelId).toBe('555555555555555555');
			expect(server.syncOnJoin).toBe(false);
			expect(server.enabled).toBe(false);
		});

		it('should re-enable a previously soft-deleted server', () => {
			const col = makeCollection();
			const server = Server.add({
				guildId: '333333333333333333',
				collectionId: col.id,
				addedBy: '444444444444444444'
			});

			server.remove(); // soft-delete
			expect(server.enabled).toBe(false);

			const reAdded = Server.add({
				guildId: '333333333333333333',
				collectionId: col.id,
				addedBy: '555555555555555555'
			});

			expect(reAdded.id).toBe(server.id); // same record
			expect(reAdded.enabled).toBe(true);
			expect(reAdded.addedBy).toBe('555555555555555555');
		});
	});

	describe('getById', () => {
		it('should fetch an existing server', () => {
			const col = makeCollection();
			const server = Server.add({ guildId: '333', collectionId: col.id, addedBy: '444' });
			const fetched = Server.getById(server.id);
			expect(fetched.guildId).toBe('333');
		});

		it('should throw for missing id', () => {
			expect(() => Server.getById('nonexistent')).toThrow(RecordNotFoundError);
		});
	});

	describe('getByGuildId', () => {
		it('should find enabled server by guild id', () => {
			const col = makeCollection();
			const server = Server.add({ guildId: '333', collectionId: col.id, addedBy: '444' });
			const fetched = Server.getByGuildId('333');
			expect(fetched.id).toBe(server.id);
		});

		it('should not find disabled server', () => {
			const col = makeCollection();
			const server = Server.add({ guildId: '333', collectionId: col.id, addedBy: '444' });
			server.remove();
			expect(() => Server.getByGuildId('333')).toThrow(RecordNotFoundError);
		});
	});

	describe('getByCollectionAndGuild', () => {
		it('should find server by collection + guild', () => {
			const col = makeCollection();
			Server.add({ guildId: '333', collectionId: col.id, addedBy: '444' });
			const fetched = Server.getByCollectionAndGuild(col.id, '333');
			expect(fetched.guildId).toBe('333');
		});

		it('should throw for wrong guild', () => {
			const col = makeCollection();
			Server.add({ guildId: '333', collectionId: col.id, addedBy: '444' });
			expect(() => Server.getByCollectionAndGuild(col.id, '999')).toThrow(RecordNotFoundError);
		});
	});

	describe('listByCollection', () => {
		it('should return all servers in a collection', () => {
			const col = makeCollection();
			Server.add({ guildId: '333', collectionId: col.id, addedBy: '444' });
			Server.add({ guildId: '555', collectionId: col.id, addedBy: '444' });

			const servers = Server.listByCollection(col.id);
			expect(servers).toHaveLength(2);
		});

		it('should return empty for collection with no servers', () => {
			const col = makeCollection();
			expect(Server.listByCollection(col.id)).toEqual([]);
		});

		it('should include disabled servers', () => {
			const col = makeCollection();
			const server = Server.add({ guildId: '333', collectionId: col.id, addedBy: '444' });
			server.remove();
			const servers = Server.listByCollection(col.id);
			expect(servers).toHaveLength(1);
			expect(servers[0].enabled).toBe(false);
		});
	});

	describe('save', () => {
		it('should persist changes', () => {
			const col = makeCollection();
			const server = Server.add({ guildId: '333', collectionId: col.id, addedBy: '444' });
			server.loggingChannelId = '999';
			server.syncOnJoin = false;
			server.save();

			const fetched = Server.getById(server.id);
			expect(fetched.loggingChannelId).toBe('999');
			expect(fetched.syncOnJoin).toBe(false);
		});
	});

	describe('remove (soft-delete)', () => {
		it('should set enabled to false', () => {
			const col = makeCollection();
			const server = Server.add({ guildId: '333', collectionId: col.id, addedBy: '444' });
			server.remove();

			const fetched = Server.getById(server.id);
			expect(fetched.enabled).toBe(false);
		});
	});

	describe('reload', () => {
		it('should refresh from database', () => {
			const col = makeCollection();
			const server = Server.add({ guildId: '333', collectionId: col.id, addedBy: '444' });
			const other = Server.getById(server.id);
			other.loggingChannelId = '999';
			other.save();

			server.reload();
			expect(server.loggingChannelId).toBe('999');
		});
	});
});
