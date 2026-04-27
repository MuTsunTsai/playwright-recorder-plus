import { defineConfig } from "@rslib/core";

export default defineConfig({
	lib: [
		{
			format: "esm",
			syntax: "es2024",
			dts: {
				bundle: true,
			},
			output: {
				externals: ["ffmpeg-static", "playwright-core"],
			},
		},
		{
			format: "cjs",
			syntax: "es2024",
			output: {
				externals: ["ffmpeg-static", "playwright-core"],
			},
		},
	],
	performance: {
		buildCache: false,
	},
	output: {
		target: "node",
	},
});
