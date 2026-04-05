import { describe, it, expect } from 'vitest';
import { Collection } from '../../src/database/models/collection';
import { Ban, type EvidenceEntry } from '../../src/database/models/ban';
import { RecordNotFoundError } from '../../src/database/models/shared';

function makeCollection(guildId = '111111111111111111') {
	return Collection.create({
		mainGuildId: guildId,
		name: 'Test',
		createdBy: '222222222222222222'
	});
}

const baseBanInput = (collectionId: string) => ({
	collectionId,
	userId: '999999999999999999',
	moderatorId: '222222222222222222',
	moderatorGuildId: '111111111111111111'
});

describe('Ban model', () => {
	describe('create', () => {
		it('should create a ban with defaults', () => {
			const col = makeCollection();
			const ban = Ban.create(baseBanInput(col.id));

			expect(ban.id).toBeTruthy();
			expect(ban.collectionId).toBe(col.id);
			expect(ban.userId).toBe('999999999999999999');
			expect(ban.moderatorId).toBe('222222222222222222');
			expect(ban.moderatorGuildId).toBe('111111111111111111');
			expect(ban.timestamp).toBeTruthy();
			expect(ban.expiresAt).toBeNull();
			expect(ban.reason).toBeNull();
			expect(ban.userFacingReason).toBeNull(); // defaults to reason which is null
			expect(ban.privatiseReason).toBe(true);
			expect(ban.moderatorsInvolved).toEqual([]);
			expect(ban.evidence).toEqual([]);
			expect(ban.active).toBe(true);
			expect(ban.appliedServersRecent).toEqual([]);
			expect(ban.appliedServersHistory).toEqual([]);
			expect(ban.meta).toEqual({ runs: 1 });
		});

		it('should create a ban with all options', () => {
			const col = makeCollection();
			const evidence: EvidenceEntry[] = [
				{ id: 'ev1', type: 'image', storage: 's3', ref: 'path/to/img.png', sizeBytes: 1024 }
			];

			const ban = Ban.create({
				...baseBanInput(col.id),
				expiresAt: '2025-12-31T23:59:59.000Z',
				reason: 'Spam',
				userFacingReason: 'You were banned for spamming',
				privatiseReason: false,
				moderatorsInvolved: ['mod1', 'mod2'],
				evidence,
				active: false,
				appliedServersRecent: [{ guildId: '333', runId: 'r1', appliedAt: null, result: 'success', retryCount: 0 }],
				meta: { lastRunId: 'r1', runs: 2 }
			});

			expect(ban.expiresAt).toBe('2025-12-31T23:59:59.000Z');
			expect(ban.reason).toBe('Spam');
			expect(ban.userFacingReason).toBe('You were banned for spamming');
			expect(ban.privatiseReason).toBe(false);
			expect(ban.moderatorsInvolved).toEqual(['mod1', 'mod2']);
			expect(ban.evidence).toEqual(evidence);
			expect(ban.active).toBe(false);
			expect(ban.appliedServersRecent).toHaveLength(1);
			expect(ban.meta.lastRunId).toBe('r1');
		});

		it('should default userFacingReason to reason', () => {
			const col = makeCollection();
			const ban = Ban.create({
				...baseBanInput(col.id),
				reason: 'Internal reason'
			});
			expect(ban.userFacingReason).toBe('Internal reason');
		});

		it('should reject more than 5 evidence entries on create', () => {
			const col = makeCollection();
			const evidence: EvidenceEntry[] = Array.from({ length: 6 }, (_, i) => ({
				id: `ev${i}`,
				type: 'image' as const,
				storage: 's3' as const,
				ref: `file${i}.png`,
				sizeBytes: 100
			}));
			expect(() => Ban.create({ ...baseBanInput(col.id), evidence })).toThrow('evidence max 5 entries');
		});
	});

	describe('getById', () => {
		it('should fetch an existing ban', () => {
			const col = makeCollection();
			const ban = Ban.create(baseBanInput(col.id));
			const fetched = Ban.getById(ban.id);
			expect(fetched.userId).toBe(ban.userId);
		});

		it('should throw for missing ban', () => {
			expect(() => Ban.getById('nonexistent')).toThrow(RecordNotFoundError);
		});
	});

	describe('listByCollection', () => {
		it('should return all bans in a collection', () => {
			const col = makeCollection();
			Ban.create({ ...baseBanInput(col.id), userId: '100' });
			Ban.create({ ...baseBanInput(col.id), userId: '200' });

			expect(Ban.listByCollection(col.id)).toHaveLength(2);
		});

		it('should filter active only when requested', () => {
			const col = makeCollection();
			const ban1 = Ban.create({ ...baseBanInput(col.id), userId: '100' });
			Ban.create({ ...baseBanInput(col.id), userId: '200' });
			ban1.revoke();

			expect(Ban.listByCollection(col.id, true)).toHaveLength(1);
			expect(Ban.listByCollection(col.id, false)).toHaveLength(2);
		});
	});

	describe('findByUserId', () => {
		it('should find bans for a user', () => {
			const col = makeCollection();
			Ban.create({ ...baseBanInput(col.id), userId: '100' });
			Ban.create({ ...baseBanInput(col.id), userId: '100' });
			Ban.create({ ...baseBanInput(col.id), userId: '200' });

			expect(Ban.findByUserId('100')).toHaveLength(2);
			expect(Ban.findByUserId('200')).toHaveLength(1);
			expect(Ban.findByUserId('999')).toHaveLength(0);
		});

		it('should filter active only when requested', () => {
			const col = makeCollection();
			const ban = Ban.create({ ...baseBanInput(col.id), userId: '100' });
			Ban.create({ ...baseBanInput(col.id), userId: '100' });
			ban.revoke();

			expect(Ban.findByUserId('100', true)).toHaveLength(1);
			expect(Ban.findByUserId('100', false)).toHaveLength(2);
		});
	});

	describe('findByUsername', () => {
		it('should return all bans (username filtering is at command layer)', () => {
			const col = makeCollection();
			Ban.create({ ...baseBanInput(col.id), userId: '100' });
			Ban.create({ ...baseBanInput(col.id), userId: '200' });

			const results = Ban.findByUsername('anything');
			expect(results).toHaveLength(2);
		});

		it('should filter active only', () => {
			const col = makeCollection();
			const ban = Ban.create({ ...baseBanInput(col.id), userId: '100' });
			Ban.create({ ...baseBanInput(col.id), userId: '200' });
			ban.revoke();

			expect(Ban.findByUsername('x', true)).toHaveLength(1);
		});
	});

	describe('save', () => {
		it('should persist changes', () => {
			const col = makeCollection();
			const ban = Ban.create(baseBanInput(col.id));
			ban.reason = 'Updated reason';
			ban.expiresAt = '2026-01-01T00:00:00.000Z';
			ban.active = false;
			ban.save();

			const fetched = Ban.getById(ban.id);
			expect(fetched.reason).toBe('Updated reason');
			expect(fetched.expiresAt).toBe('2026-01-01T00:00:00.000Z');
			expect(fetched.active).toBe(false);
		});

		it('should persist complex JSON fields', () => {
			const col = makeCollection();
			const ban = Ban.create(baseBanInput(col.id));
			ban.moderatorsInvolved = ['m1', 'm2', 'm3'];
			ban.appliedServersRecent = [{ guildId: 'g1', runId: 'r1', appliedAt: '2025-01-01', result: 'success', retryCount: 0 }];
			ban.meta = { lastRunId: 'r1', runs: 5 };
			ban.save();

			const fetched = Ban.getById(ban.id);
			expect(fetched.moderatorsInvolved).toEqual(['m1', 'm2', 'm3']);
			expect(fetched.appliedServersRecent[0].guildId).toBe('g1');
			expect(fetched.meta.runs).toBe(5);
		});
	});

	describe('revoke', () => {
		it('should set active to false and save', () => {
			const col = makeCollection();
			const ban = Ban.create(baseBanInput(col.id));
			expect(ban.active).toBe(true);
			ban.revoke();
			expect(ban.active).toBe(false);

			const fetched = Ban.getById(ban.id);
			expect(fetched.active).toBe(false);
		});
	});

	describe('remove', () => {
		it('should behave like revoke (soft-delete)', () => {
			const col = makeCollection();
			const ban = Ban.create(baseBanInput(col.id));
			ban.remove();
			const fetched = Ban.getById(ban.id);
			expect(fetched.active).toBe(false);
		});
	});

	describe('evidence setter', () => {
		it('should reject more than 5 entries via setter', () => {
			const col = makeCollection();
			const ban = Ban.create(baseBanInput(col.id));
			const sixEntries: EvidenceEntry[] = Array.from({ length: 6 }, (_, i) => ({
				id: `ev${i}`,
				type: 'image' as const,
				storage: 's3' as const,
				ref: `file${i}.png`,
				sizeBytes: 100
			}));
			expect(() => { ban.evidence = sixEntries; }).toThrow('evidence max 5 entries');
		});

		it('should accept up to 5 entries', () => {
			const col = makeCollection();
			const ban = Ban.create(baseBanInput(col.id));
			const fiveEntries: EvidenceEntry[] = Array.from({ length: 5 }, (_, i) => ({
				id: `ev${i}`,
				type: 'image' as const,
				storage: 's3' as const,
				ref: `file${i}.png`,
				sizeBytes: 100
			}));
			ban.evidence = fiveEntries;
			expect(ban.evidence).toHaveLength(5);
		});
	});

	describe('reload', () => {
		it('should refresh from database', () => {
			const col = makeCollection();
			const ban = Ban.create(baseBanInput(col.id));
			const other = Ban.getById(ban.id);
			other.reason = 'Changed externally';
			other.save();

			ban.reload();
			expect(ban.reason).toBe('Changed externally');
		});
	});
});
