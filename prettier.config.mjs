/** @type {import("prettier").Config} */
export default {
	plugins: ['@ianvs/prettier-plugin-sort-imports'],
	semi: false,
	singleQuote: true,
	useTabs: true,
	importOrder: [
		'<TYPES>',
		'^(react/(.*)$)|^(react$)|^(react-native(.*)$)',
		'^(next/(.*)$)|^(next$)',
		'^(expo(.*)$)|^(expo$)',
		'<THIRD_PARTY_MODULES>',
		'',
		'<TYPES>^@mobsol',
		'^@mobsol/(.*)$',
		'',
		'<TYPES>^[.|..|~]',
		'^~/',
		'^[../]',
		'^[./]',
	],
	importOrderParserPlugins: ['typescript', 'jsx', 'decorators-legacy'],
	importOrderTypeScriptVersion: '4.4.0',
}
