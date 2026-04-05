import { beforeEach, afterAll } from 'vitest';
import { initDb, resetDb, connectDb } from './__mocks__/main';

beforeEach(() => {
	resetDb();
	initDb();
});

afterAll(() => {
	resetDb();
});

// Helper to create a collection for tests that need a foreign key reference
export function createTestCollection(overrides: Partial<{ mainGuildId: string; name: string; createdBy: string }> = {}) {
	const { Collection } = require('../src/database/models/collection');
	return Collection.create({
		mainGuildId: overrides.mainGuildId ?? '111111111111111111',
		name: overrides.name ?? 'Test Collection',
		createdBy: overrides.createdBy ?? '222222222222222222'
	});
}
