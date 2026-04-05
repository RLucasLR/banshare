import { describe, it, expect } from 'vitest';
import { RecordNotFoundError, newId, isValidId, toDbBool, fromDbBool, nowIso, parseJson, stringifyJson } from '../../src/database/models/shared';

describe('shared utilities', () => {
	describe('RecordNotFoundError', () => {
		it('should create an error with the correct name and message', () => {
			const error = new RecordNotFoundError('Collection not found: abc');
			expect(error).toBeInstanceOf(Error);
			expect(error).toBeInstanceOf(RecordNotFoundError);
			expect(error.name).toBe('RecordNotFoundError');
			expect(error.message).toBe('Collection not found: abc');
		});

		it('should be catchable as Error', () => {
			try {
				throw new RecordNotFoundError('not found');
			} catch (e) {
				expect(e).toBeInstanceOf(Error);
			}
		});
	});

	describe('newId', () => {
		it('should return a valid UUID v4', () => {
			const id = newId();
			expect(isValidId(id)).toBe(true);
		});

		it('should return unique values on each call', () => {
			const ids = new Set(Array.from({ length: 100 }, () => newId()));
			expect(ids.size).toBe(100);
		});
	});

	describe('isValidId', () => {
		it('should validate correct UUIDs', () => {
			expect(isValidId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
			expect(isValidId('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(true);
		});

		it('should reject invalid UUIDs', () => {
			expect(isValidId('')).toBe(false);
			expect(isValidId('not-a-uuid')).toBe(false);
			expect(isValidId('550e8400-e29b-41d4-a716')).toBe(false);
			expect(isValidId('550e8400-e29b-41d4-a716-44665544000g')).toBe(false);
			expect(isValidId('550e8400e29b41d4a716446655440000')).toBe(false);
		});
	});

	describe('toDbBool / fromDbBool', () => {
		it('should convert booleans to 0/1', () => {
			expect(toDbBool(true)).toBe(1);
			expect(toDbBool(false)).toBe(0);
		});

		it('should convert 0/1 to booleans', () => {
			expect(fromDbBool(1)).toBe(true);
			expect(fromDbBool(0)).toBe(false);
		});

		it('should treat non-1 values as false', () => {
			expect(fromDbBool(2)).toBe(false);
			expect(fromDbBool(-1)).toBe(false);
		});

		it('should roundtrip correctly', () => {
			expect(fromDbBool(toDbBool(true))).toBe(true);
			expect(fromDbBool(toDbBool(false))).toBe(false);
		});
	});

	describe('nowIso', () => {
		it('should return a valid ISO 8601 string', () => {
			const iso = nowIso();
			const parsed = new Date(iso);
			expect(parsed.toISOString()).toBe(iso);
		});

		it('should return a recent timestamp', () => {
			const before = Date.now();
			const iso = nowIso();
			const after = Date.now();
			const ts = new Date(iso).getTime();
			expect(ts).toBeGreaterThanOrEqual(before);
			expect(ts).toBeLessThanOrEqual(after);
		});
	});

	describe('parseJson', () => {
		it('should parse valid JSON', () => {
			expect(parseJson('{"a":1}', {})).toEqual({ a: 1 });
			expect(parseJson('[1,2,3]', [])).toEqual([1, 2, 3]);
			expect(parseJson('"hello"', '')).toBe('hello');
		});

		it('should return fallback for invalid JSON', () => {
			expect(parseJson('not json', { fallback: true })).toEqual({ fallback: true });
			expect(parseJson('', [])).toEqual([]);
			expect(parseJson('{broken', 'default')).toBe('default');
		});
	});

	describe('stringifyJson', () => {
		it('should stringify values', () => {
			expect(stringifyJson({ a: 1 })).toBe('{"a":1}');
			expect(stringifyJson([1, 2])).toBe('[1,2]');
			expect(stringifyJson(null)).toBe('null');
			expect(stringifyJson('hello')).toBe('"hello"');
		});
	});
});
