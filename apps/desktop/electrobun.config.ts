import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "DataGripe",
		identifier: "app.datagripe.dev",
		version: "0.0.1",
	},
	build: {
		mainProcess: "cottontail",
		cottontail: {
			entrypoint: "src/main.ts",
		},
		// No bundled views: the webview loads http://localhost:<port>/ from
		// the DataGripe server, which serves apps/web/dist (WEB_STATIC_DIR)
		// so /api and /ws stay same-origin.
		views: {},
		mac: {
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;
