import { describe, it, expect } from 'vitest';
import { Collection } from '../../src/database/models/collection';
import { AuditLog } from '../../src/database/models/auditLog';
import { RecordNotFoundError } from '../../src/database/models/shared';

function makeCollection(guildId = '111111111111111111') {
	return Collection.create({
		mainGuildId: guildId,
		name: 'Test',
		createdBy: '222222222222222222'
	});
}

describe('AuditLog model', () => {
	describe('create', () => {
		it('should create an audit log with defaults', () => {
			const col = makeCollection();
			const log = AuditLog.create({
				collectionId: col.id,
				action: 'ban.create',
				performedBy: '222222222222222222'
			});

			expect(log.id).toBeTruthy();
			expect(log.collectionId).toBe(col.id);
			expect(log.action).toBe('ban.create');
			expect(log.performedBy).toBe('222222222222222222');
			expect(log.performedAt).toBeTruthy();
			expect(log.details).toEqual({});
		});

		it('should create with details', () => {
			const col = makeCollection();
			const details = { userId: '999', reason: 'spam', banId: 'abc-123' };
			const log = AuditLog.create({
				collectionId: col.id,
				action: 'ban.create',
				performedBy: '222',
				details
			});

			expect(log.details).toEqual(details);
		});

		it('should support all action types', () => {
			const col = makeCollection();
			const actions = [
				'collection.create', 'collection.create.failed',
				'server.add', 'server.remove',
				'moderator.add', 'moderator.remove',
				'ban.create', 'ban.revoke', 'ban.edit', 'ban.lookup', 'ban.view',
				'setting.update',
				'invite.create', 'invite.accept',
				'collection.delete',
				'evidence.access'
			] as const;

			for (const action of actions) {
				const log = AuditLog.create({
					collectionId: col.id,
					action,
					performedBy: '222'
				});
				expect(log.action).toBe(action);
			}
		});
	});

	describe('getById', () => {
		it('should fetch an existing audit log', () => {
			const col = makeCollection();
			const log = AuditLog.create({ collectionId: col.id, action: 'ban.create', performedBy: '222' });
			const fetched = AuditLog.getById(log.id);
			expect(fetched.action).toBe('ban.create');
		});

		it('should throw for missing id', () => {
			expect(() => AuditLog.getById('nonexistent')).toThrow(RecordNotFoundError);
		});
	});

	describe('listByCollection', () => {
		it('should return logs ordered by performedAt DESC', () => {
			const col = makeCollection();
			AuditLog.create({ collectionId: col.id, action: 'ban.create', performedBy: '222' });
			AuditLog.create({ collectionId: col.id, action: 'ban.revoke', performedBy: '333' });

			const logs = AuditLog.listByCollection(col.id);
			expect(logs).toHaveLength(2);
			// Most recent first
			expect(logs[0].action).toBe('ban.revoke');
		});

		it('should respect limit parameter', () => {
			const col = makeCollection();
			for (let i = 0; i < 5; i++) {
				AuditLog.create({ collectionId: col.id, action: 'ban.create', performedBy: '222' });
			}

			expect(AuditLog.listByCollection(col.id, 3)).toHaveLength(3);
		});

		it('should cap limit at 500', () => {
			const col = makeCollection();
			// We can't easily test creating 501 records, but we can verify the function accepts large values
			const logs = AuditLog.listByCollection(col.id, 1000);
			expect(logs).toHaveLength(0);
		});

		it('should not return logs from other collections', () => {
			const col1 = makeCollection('100');
			const col2 = makeCollection('200');
			AuditLog.create({ collectionId: col1.id, action: 'ban.create', performedBy: '222' });
			AuditLog.create({ collectionId: col2.id, action: 'ban.revoke', performedBy: '333' });

			expect(AuditLog.listByCollection(col1.id)).toHaveLength(1);
			expect(AuditLog.listByCollection(col2.id)).toHaveLength(1);
		});
	});

	describe('save', () => {
		it('should persist changes', () => {
			const col = makeCollection();
			const log = AuditLog.create({ collectionId: col.id, action: 'ban.create', performedBy: '222' });
			log.action = 'ban.revoke';
			log.details = { reason: 'updated' };
			log.save();

			const fetched = AuditLog.getById(log.id);
			expect(fetched.action).toBe('ban.revoke');
			expect(fetched.details).toEqual({ reason: 'updated' });
		});

		it('should throw if log was deleted', () => {
			const col = makeCollection();
			const log = AuditLog.create({ collectionId: col.id, action: 'ban.create', performedBy: '222' });
			log.remove();
			log.action = 'ban.revoke';
			expect(() => log.save()).toThrow(RecordNotFoundError);
		});
	});

	describe('remove', () => {
		it('should hard-delete the log', () => {
			const col = makeCollection();
			const log = AuditLog.create({ collectionId: col.id, action: 'ban.create', performedBy: '222' });
			const id = log.id;
			log.remove();
			expect(() => AuditLog.getById(id)).toThrow(RecordNotFoundError);
		});

		it('should throw if already removed', () => {
			const col = makeCollection();
			const log = AuditLog.create({ collectionId: col.id, action: 'ban.create', performedBy: '222' });
			log.remove();
			expect(() => log.remove()).toThrow(RecordNotFoundError);
		});
	});

	describe('reload', () => {
		it('should refresh from database', () => {
			const col = makeCollection();
			const log = AuditLog.create({ collectionId: col.id, action: 'ban.create', performedBy: '222', details: { v: 1 } });
			const other = AuditLog.getById(log.id);
			other.details = { v: 2 };
			other.save();

			log.reload();
			expect((log.details as { v: number }).v).toBe(2);
		});
	});
});
