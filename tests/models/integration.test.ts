import { describe, it, expect } from 'vitest';
import { Collection } from '../../src/database/models/collection';
import { Server } from '../../src/database/models/server';
import { Ban } from '../../src/database/models/ban';
import { Moderator } from '../../src/database/models/moderator';
import { AuditLog } from '../../src/database/models/auditLog';
import { Invite } from '../../src/database/models/invite';
import { RecordNotFoundError } from '../../src/database/models/shared';

describe('cross-model integration', () => {
	describe('collection cascade delete', () => {
		it('should delete all related records when collection is removed', () => {
			const col = Collection.create({
				mainGuildId: '111',
				name: 'Cascade Test',
				createdBy: '222'
			});

			// Create related records
			const server = Server.add({ guildId: '333', collectionId: col.id, addedBy: '222' });
			const ban = Ban.create({ collectionId: col.id, userId: '999', moderatorId: '222', moderatorGuildId: '111' });
			const mod = Moderator.grant({ collectionId: col.id, type: 'user', value: '444', grantedBy: '222' });
			const log = AuditLog.create({ collectionId: col.id, action: 'ban.create', performedBy: '222' });
			const invite = Invite.create({ collectionId: col.id, targetGuildId: '555', invitedBy: '222' });

			// Remove collection
			col.remove();

			// All should be gone
			expect(() => Collection.getById(col.id)).toThrow(RecordNotFoundError);
			// Server record is deleted (not soft-deleted)
			expect(() => Server.getById(server.id)).toThrow(RecordNotFoundError);
			expect(() => Ban.getById(ban.id)).toThrow(RecordNotFoundError);
			expect(() => Moderator.getById(mod.id)).toThrow(RecordNotFoundError);
			expect(() => AuditLog.getById(log.id)).toThrow(RecordNotFoundError);
			expect(() => Invite.getById(invite.id)).toThrow(RecordNotFoundError);
		});
	});

	describe('full ban workflow', () => {
		it('should support create -> edit -> revoke lifecycle', () => {
			const col = Collection.create({ mainGuildId: '111', name: 'Ban Workflow', createdBy: '222' });
			Server.add({ guildId: '333', collectionId: col.id, addedBy: '222' });
			Server.add({ guildId: '444', collectionId: col.id, addedBy: '222' });

			// Create ban
			const ban = Ban.create({
				collectionId: col.id,
				userId: '999',
				moderatorId: '222',
				moderatorGuildId: '111',
				reason: 'Initial reason'
			});
			expect(ban.active).toBe(true);

			// Edit ban
			ban.reason = 'Updated reason';
			ban.evidence = [{ id: 'ev1', type: 'image', storage: 's3', ref: 'img.png', sizeBytes: 500 }];
			ban.appliedServersRecent = [
				{ guildId: '333', runId: 'r1', appliedAt: new Date().toISOString(), result: 'success', retryCount: 0 },
				{ guildId: '444', runId: 'r1', appliedAt: new Date().toISOString(), result: 'failed', error: 'Missing perms', retryCount: 1 }
			];
			ban.save();

			// Verify edit persisted
			const fetched = Ban.getById(ban.id);
			expect(fetched.reason).toBe('Updated reason');
			expect(fetched.evidence).toHaveLength(1);
			expect(fetched.appliedServersRecent).toHaveLength(2);
			expect(fetched.appliedServersRecent[1].result).toBe('failed');

			// Revoke ban
			ban.revoke();
			const revoked = Ban.getById(ban.id);
			expect(revoked.active).toBe(false);

			// Active filter should exclude it
			expect(Ban.listByCollection(col.id, true)).toHaveLength(0);
			expect(Ban.listByCollection(col.id, false)).toHaveLength(1);
		});
	});

	describe('invite -> join workflow', () => {
		it('should support invite creation, acceptance, and server joining', () => {
			const col = Collection.create({ mainGuildId: '111', name: 'Invite Test', createdBy: '222' });

			// Create invite
			const invite = Invite.create({ collectionId: col.id, targetGuildId: '333', invitedBy: '222' });
			expect(invite.status).toBe('pending');
			expect(Invite.hasPendingInvite(col.id, '333')).toBe(true);

			// Accept invite
			invite.accept();
			expect(invite.status).toBe('accepted');
			expect(Invite.hasPendingInvite(col.id, '333')).toBe(false);

			// Join collection
			const server = Server.add({ guildId: '333', collectionId: col.id, addedBy: '222' });
			expect(server.enabled).toBe(true);

			const servers = Server.listByCollection(col.id);
			expect(servers).toHaveLength(1);
		});
	});

	describe('moderator permissions across collections', () => {
		it('should isolate moderators per collection', () => {
			const col1 = Collection.create({ mainGuildId: '100', name: 'Col 1', createdBy: '222' });
			const col2 = Collection.create({ mainGuildId: '200', name: 'Col 2', createdBy: '222' });

			Moderator.grant({ collectionId: col1.id, type: 'user', value: '333', grantedBy: '222' });
			Moderator.grant({ collectionId: col2.id, type: 'user', value: '333', grantedBy: '222' });
			Moderator.grant({ collectionId: col2.id, type: 'role', value: '444', grantedBy: '222' });

			expect(Moderator.listByCollection(col1.id)).toHaveLength(1);
			expect(Moderator.listByCollection(col2.id)).toHaveLength(2);

			// Can find by composite key
			const mod = Moderator.getByCollectionTypeValue(col1.id, 'user', '333');
			expect(mod.collectionId).toBe(col1.id);

			// Removing from one doesn't affect the other
			mod.remove();
			expect(Moderator.listByCollection(col1.id)).toHaveLength(0);
			expect(Moderator.listByCollection(col2.id)).toHaveLength(2);
		});
	});

	describe('server re-enable after soft-delete', () => {
		it('should preserve the same server id when re-added', () => {
			const col = Collection.create({ mainGuildId: '111', name: 'Re-enable', createdBy: '222' });
			const server = Server.add({ guildId: '333', collectionId: col.id, addedBy: '222', loggingChannelId: '555' });
			const originalId = server.id;

			server.remove();

			const reAdded = Server.add({
				guildId: '333',
				collectionId: col.id,
				addedBy: '666',
				loggingChannelId: '777'
			});

			expect(reAdded.id).toBe(originalId);
			expect(reAdded.enabled).toBe(true);
			expect(reAdded.addedBy).toBe('666');
			expect(reAdded.loggingChannelId).toBe('777');
		});
	});

	describe('audit logging for multiple actions', () => {
		it('should track a sequence of actions', () => {
			const col = Collection.create({ mainGuildId: '111', name: 'Audit Trail', createdBy: '222' });

			AuditLog.create({ collectionId: col.id, action: 'collection.create', performedBy: '222' });
			AuditLog.create({ collectionId: col.id, action: 'server.add', performedBy: '222', details: { guildId: '333' } });
			AuditLog.create({ collectionId: col.id, action: 'moderator.add', performedBy: '222', details: { type: 'user', value: '444' } });
			AuditLog.create({ collectionId: col.id, action: 'ban.create', performedBy: '222', details: { userId: '999' } });
			AuditLog.create({ collectionId: col.id, action: 'ban.revoke', performedBy: '222', details: { userId: '999' } });

			const logs = AuditLog.listByCollection(col.id);
			expect(logs).toHaveLength(5);
			// Most recent first
			expect(logs[0].action).toBe('ban.revoke');
			expect(logs[4].action).toBe('collection.create');

			// Verify details are preserved
			const serverAddLog = logs.find((l) => l.action === 'server.add');
			expect((serverAddLog!.details as { guildId: string }).guildId).toBe('333');
		});
	});

	describe('multiple bans for same user', () => {
		it('should allow multiple bans across collections', () => {
			const col1 = Collection.create({ mainGuildId: '100', name: 'Col 1', createdBy: '222' });
			const col2 = Collection.create({ mainGuildId: '200', name: 'Col 2', createdBy: '222' });

			Ban.create({ collectionId: col1.id, userId: '999', moderatorId: '222', moderatorGuildId: '100' });
			Ban.create({ collectionId: col2.id, userId: '999', moderatorId: '333', moderatorGuildId: '200' });

			const userBans = Ban.findByUserId('999');
			expect(userBans).toHaveLength(2);
			expect(Ban.listByCollection(col1.id)).toHaveLength(1);
			expect(Ban.listByCollection(col2.id)).toHaveLength(1);
		});

		it('should allow multiple bans in same collection for same user', () => {
			const col = Collection.create({ mainGuildId: '111', name: 'Multi-ban', createdBy: '222' });

			const ban1 = Ban.create({ collectionId: col.id, userId: '999', moderatorId: '222', moderatorGuildId: '111', reason: 'First offense' });
			ban1.revoke();

			Ban.create({ collectionId: col.id, userId: '999', moderatorId: '222', moderatorGuildId: '111', reason: 'Second offense' });

			const allBans = Ban.findByUserId('999');
			expect(allBans).toHaveLength(2);

			const activeBans = Ban.findByUserId('999', true);
			expect(activeBans).toHaveLength(1);
			expect(activeBans[0].reason).toBe('Second offense');
		});
	});
});
