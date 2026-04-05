import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
	test: {
		globals: true,
		root: '.',
		include: ['tests/**/*.test.ts'],
		setupFiles: ['tests/setup.ts'],
		coverage: {
			provider: 'v8',
			include: ['src/database/models/**', 'src/lib/utils.ts'],
			reporter: ['text', 'text-summary']
		}
	},
	resolve: {
		alias: {
			'../main': path.resolve(__dirname, 'tests/__mocks__/main.ts'),
			'../../main': path.resolve(__dirname, 'tests/__mocks__/main.ts')
		}
	}
});
