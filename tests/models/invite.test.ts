import { describe, it, expect, vi } from 'vitest';
import { Collection } from '../../src/database/models/collection';
import { Invite } from '../../src/database/models/invite';
import { RecordNotFoundError } from '../../src/database/models/shared';
import { connectDb } from '../__mocks__/main';

function makeCollection(guildId = '111111111111111111') {
	return Collection.create({
		mainGuildId: guildId,
		name: 'Test',
		createdBy: '222222222222222222'
	});
}

describe('Invite model', () => {
	describe('create', () => {
		it('should create a pending invite with 48h expiry', () => {
			const col = makeCollection();
			const before = Date.now();
			const invite = Invite.create({
				collectionId: col.id,
				targetGuildId: '333333333333333333',
				invitedBy: '222222222222222222'
			});

			expect(invite.id).toBeTruthy();
			expect(invite.collectionId).toBe(col.id);
			expect(invite.targetGuildId).toBe('333333333333333333');
			expect(invite.invitedBy).toBe('222222222222222222');
			expect(invite.invitedAt).toBeTruthy();
			expect(invite.status).toBe('pending');
			expect(invite.respondedAt).toBeNull();

			// Expiry should be ~48 hours from now
			const expiresMs = new Date(invite.expiresAt).getTime();
			const expectedMs = before + 48 * 60 * 60 * 1000;
			expect(expiresMs).toBeGreaterThanOrEqual(expectedMs - 2000);
			expect(expiresMs).toBeLessThanOrEqual(expectedMs + 2000);
		});
	});

	describe('getById', () => {
		it('should fetch an existing invite', () => {
			const col = makeCollection();
			const invite = Invite.create({ collectionId: col.id, targetGuildId: '333', invitedBy: '222' });
			const fetched = Invite.getById(invite.id);
			expect(fetched.targetGuildId).toBe('333');
		});

		it('should throw for missing id', () => {
			expect(() => Invite.getById('nonexistent')).toThrow(RecordNotFoundError);
		});
	});

	describe('getPendingForGuild', () => {
		it('should find pending non-expired invite', () => {
			const col = makeCollection();
			Invite.create({ collectionId: col.id, targetGuildId: '333', invitedBy: '222' });

			const found = Invite.getPendingForGuild('333');
			expect(found).not.toBeNull();
			expect(found!.targetGuildId).toBe('333');
		});

		it('should return null when no pending invites', () => {
			expect(Invite.getPendingForGuild('999')).toBeNull();
		});

		it('should not return accepted invites', () => {
			const col = makeCollection();
			const invite = Invite.create({ collectionId: col.id, targetGuildId: '333', invitedBy: '222' });
			invite.accept();

			expect(Invite.getPendingForGuild('333')).toBeNull();
		});

		it('should not return cancelled invites', () => {
			const col = makeCollection();
			const invite = Invite.create({ collectionId: col.id, targetGuildId: '333', invitedBy: '222' });
			invite.cancel();

			expect(Invite.getPendingForGuild('333')).toBeNull();
		});
	});

	describe('listPendingForGuild', () => {
		it('should list all pending invites for a guild', () => {
			const col1 = makeCollection('100');
			const col2 = makeCollection('200');
			Invite.create({ collectionId: col1.id, targetGuildId: '333', invitedBy: '222' });
			Invite.create({ collectionId: col2.id, targetGuildId: '333', invitedBy: '222' });

			const pending = Invite.listPendingForGuild('333');
			expect(pending).toHaveLength(2);
		});

		it('should exclude non-pending invites', () => {
			const col = makeCollection();
			const invite = Invite.create({ collectionId: col.id, targetGuildId: '333', invitedBy: '222' });
			Invite.create({ collectionId: col.id, targetGuildId: '333', invitedBy: '222' });
			invite.accept();

			// Due to unique constraint on (collectionId, targetGuildId) for invites... actually there's no such constraint
			// So both should exist but only one is pending
			const pending = Invite.listPendingForGuild('333');
			expect(pending).toHaveLength(1);
		});
	});

	describe('listByCollection', () => {
		it('should list all invites for a collection', () => {
			const col = makeCollection();
			Invite.create({ collectionId: col.id, targetGuildId: '333', invitedBy: '222' });
			Invite.create({ collectionId: col.id, targetGuildId: '444', invitedBy: '222' });

			expect(Invite.listByCollection(col.id)).toHaveLength(2);
		});

		it('should include invites of all statuses', () => {
			const col = makeCollection();
			const inv1 = Invite.create({ collectionId: col.id, targetGuildId: '333', invitedBy: '222' });
			Invite.create({ collectionId: col.id, targetGuildId: '444', invitedBy: '222' });
			inv1.accept();

			const all = Invite.listByCollection(col.id);
			expect(all).toHaveLength(2);
		});
	});

	describe('hasPendingInvite', () => {
		it('should return true when pending invite exists', () => {
			const col = makeCollection();
			Invite.create({ collectionId: col.id, targetGuildId: '333', invitedBy: '222' });

			expect(Invite.hasPendingInvite(col.id, '333')).toBe(true);
		});

		it('should return false when no invite exists', () => {
			const col = makeCollection();
			expect(Invite.hasPendingInvite(col.id, '333')).toBe(false);
		});

		it('should return false when invite was accepted', () => {
			const col = makeCollection();
			const invite = Invite.create({ collectionId: col.id, targetGuildId: '333', invitedBy: '222' });
			invite.accept();

			expect(Invite.hasPendingInvite(col.id, '333')).toBe(false);
		});
	});

	describe('isExpired', () => {
		it('should return false for fresh invite', () => {
			const col = makeCollection();
			const invite = Invite.create({ collectionId: col.id, targetGuildId: '333', invitedBy: '222' });
			expect(invite.isExpired()).toBe(false);
		});

		it('should return true for expired invite', () => {
			const col = makeCollection();
			const invite = Invite.create({ collectionId: col.id, targetGuildId: '333', invitedBy: '222' });

			// Manually set expiresAt to the past via direct DB update
			const db = connectDb();
			db.prepare('UPDATE invites SET expiresAt = ? WHERE _id = ?').run('2020-01-01T00:00:00.000Z', invite.id);
			invite.reload();

			expect(invite.isExpired()).toBe(true);
		});
	});

	describe('accept', () => {
		it('should set status to accepted with timestamp', () => {
			const col = makeCollection();
			const invite = Invite.create({ collectionId: col.id, targetGuildId: '333', invitedBy: '222' });
			invite.accept();

			expect(invite.status).toBe('accepted');
			expect(invite.respondedAt).toBeTruthy();

			const fetched = Invite.getById(invite.id);
			expect(fetched.status).toBe('accepted');
		});
	});

	describe('cancel', () => {
		it('should set status to cancelled with timestamp', () => {
			const col = makeCollection();
			const invite = Invite.create({ collectionId: col.id, targetGuildId: '333', invitedBy: '222' });
			invite.cancel();

			expect(invite.status).toBe('cancelled');
			expect(invite.respondedAt).toBeTruthy();
		});
	});

	describe('expire', () => {
		it('should set status to expired with timestamp', () => {
			const col = makeCollection();
			const invite = Invite.create({ collectionId: col.id, targetGuildId: '333', invitedBy: '222' });
			invite.expire();

			expect(invite.status).toBe('expired');
			expect(invite.respondedAt).toBeTruthy();
		});
	});

	describe('save', () => {
		it('should persist status changes', () => {
			const col = makeCollection();
			const invite = Invite.create({ collectionId: col.id, targetGuildId: '333', invitedBy: '222' });
			invite.status = 'cancelled';
			invite.respondedAt = new Date().toISOString();
			invite.save();

			const fetched = Invite.getById(invite.id);
			expect(fetched.status).toBe('cancelled');
			expect(fetched.respondedAt).toBeTruthy();
		});

		it('should throw if invite was deleted externally', () => {
			const col = makeCollection();
			const invite = Invite.create({ collectionId: col.id, targetGuildId: '333', invitedBy: '222' });

			// Delete directly
			const db = connectDb();
			db.prepare('DELETE FROM invites WHERE _id = ?').run(invite.id);

			expect(() => invite.save()).toThrow(RecordNotFoundError);
		});
	});

	describe('reload', () => {
		it('should refresh from database', () => {
			const col = makeCollection();
			const invite = Invite.create({ collectionId: col.id, targetGuildId: '333', invitedBy: '222' });
			const other = Invite.getById(invite.id);
			other.accept();

			invite.reload();
			expect(invite.status).toBe('accepted');
		});
	});
});
