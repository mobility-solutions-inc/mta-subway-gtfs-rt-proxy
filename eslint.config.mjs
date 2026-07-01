import js from '@eslint/js'
import importPlugin from 'eslint-plugin-import'
import tseslint from 'typescript-eslint'

export default tseslint.config(
	js.configs.recommended,
	...tseslint.configs.recommended,
	...tseslint.configs.recommendedTypeChecked,
	...tseslint.configs.stylisticTypeChecked,
	{
		ignores: [
			'**/*.config.js',
			'**/*.config.cjs',
			'**/*.config.mjs',
			'**/.eslintrc.cjs',
			'eslint.config.mjs',
			'.cache',
			'dist',
			'pnpm-lock.yaml',
			'google-transit',
			'postgis-gtfs-importer',
			'python-nyct-gtfs',
			'curl-mirror.mjs',
			'lib/gtfs-realtime.proto',
			'lib/mta-gtfs-realtime.proto',
			'lib/mta-gtfs-realtime.pb.d.ts',
			'lib/mta-gtfs-realtime.pb.js',
		],
	},
	{
		files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx', '**/*.mjs'],
		plugins: {
			import: importPlugin,
		},
		languageOptions: {
			parserOptions: {
				project: true,
			},
		},
		linterOptions: {
			reportUnusedDisableDirectives: true,
		},
		rules: {
			'no-undef': 'off',
			'@typescript-eslint/no-unused-vars': [
				'error',
				{
					argsIgnorePattern: '^_',
					varsIgnorePattern: '^_',
				},
			],
			'@typescript-eslint/consistent-type-imports': [
				'warn',
				{
					fixStyle: 'separate-type-imports',
					prefer: 'type-imports',
				},
			],
			'@typescript-eslint/no-misused-promises': [
				'error',
				{
					checksVoidReturn: {
						attributes: false,
					},
				},
			],
			'@typescript-eslint/unbound-method': 'off',
			'import/consistent-type-specifier-style': ['error', 'prefer-top-level'],
			'@typescript-eslint/no-deprecated': 'warn',
		},
	},
	{
		files: ['test/**/*.ts'],
		rules: {
			'@typescript-eslint/no-floating-promises': 'off',
			'@typescript-eslint/no-misused-promises': 'off',
		},
	},
)
