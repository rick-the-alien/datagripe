export default {
	scripts: {
		install: ["hutch", "install", "--frozen-lockfile"],
		// Builds the web app, then launches the Electrobun shell with the
		// monorepo server spawned as a child (embedded postgres, no auth).
		dev: ["hutch", "electrobun", "dev", "--watch"],
		build: ["hutch", "electrobun", "build", "--env=stable"],
	},
	electrobun: {
		version: "2.0.1",
	},
};
