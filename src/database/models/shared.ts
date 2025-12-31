import { randomUUID } from 'node:crypto';

export class RecordNotFoundError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'RecordNotFoundError';
	}
}

export const newId = (): string => randomUUID();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isValidId = (id: string): boolean => UUID_REGEX.test(id);

export const toDbBool = (value: boolean): 0 | 1 => (value ? 1 : 0);

export const fromDbBool = (value: number): boolean => value === 1;

export const nowIso = (): string => new Date().toISOString();

export const parseJson = <T>(json: string, fallback: T): T => {
	try {
		return JSON.parse(json) as T;
	} catch {
		return fallback;
	}
};

export const stringifyJson = (value: unknown): string => {
	return JSON.stringify(value);
};
