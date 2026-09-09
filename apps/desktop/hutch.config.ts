export default {
	scripts: {
		install: ["hutch", "install", "--frozen-lockfile"],
		// Launches the Electrobun shell with the checkout's server spawned
		// as a child (embedded postgres, no auth). Needs the web app built
		// once: `bun run --cwd apps/web build`.
		dev: ["hutch", "electrobun", "dev", "--watch"],
		// Stages the backend into `staged/` first — a packaged build has no
		// checkout to run the server from. See `scripts/bundle-server.ts`.
		build: ["bun", "run", "build"],
	},
	electrobun: {
		version: "2.0.1",
	},
};
