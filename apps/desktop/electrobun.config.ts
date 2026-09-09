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
		// the DataGripe server, which serves the built web app
		// (WEB_STATIC_DIR) so /api and /ws stay same-origin.
		views: {},
		// The backend, staged by `scripts/bundle-server.ts`. Destinations
		// are relative to `Resources/app`, so these land beside the shell's
		// own `bun/index.js` — where `src/main.ts` looks for them. Postgres
		// is separate, and shallow, to keep every path inside the
		// installer's 100-character tar limit.
		copy: {
			"staged/server": "server",
			"staged/pg": "pg",
		},
		mac: {
			// No icon yet: Electrobun wants an `icon.iconset` directory
			// here, and Windows has no icon setting in 2.0.1 at all.
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
			// Copied to `Resources/appIcon.png` and referenced as
			// `Icon=appIcon` by the generated .desktop entry, which the
			// installer rewrites to the installed absolute path. Without it
			// the entry has no Icon= line at all and the launcher shows a
			// broken image.
			icon: "icon.png",
		},
		win: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;
