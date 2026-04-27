import { createConfig } from "@mutsuntsai/eslint";

export default [
	...createConfig({
		ignores: [
			"node_modules/**",
			"dist/**",
			".rslib/**",
		],
		import: {
			files: ["**/*.ts", "eslint.config.js"],
			project: ["."],
		},
		globals: {
			esm: ["**/*.ts", "./*.js"],
		},
		playwright: ["test/**/*.ts"],
	}),
];
