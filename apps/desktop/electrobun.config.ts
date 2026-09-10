import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "DataGripe",
		identifier: "app.datagripe.dev",
		version: "0.0.4",
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
	release: {
		// GitHub redirects `releases/latest/download/<asset>` to the newest
		// non-prerelease release, which is exactly what a stable channel
		// wants to point at. The release workflow uploads
		// `apps/desktop/artifacts/stable-*` under the names the build gives
		// them — `<channel>-<os>-<arch>-update.json` and the bundle it
		// names — which is what `Updater.checkForUpdate` goes looking for.
		baseUrl:
			"https://github.com/rick-the-alien/datagripe/releases/latest/download",
		// Full bundles, not deltas. A patch is diffed against the previous
		// release's artifact at build time, and the release job builds each
		// platform from a clean checkout with nothing to diff against.
		generatePatch: false,
	},
} satisfies ElectrobunConfig;
