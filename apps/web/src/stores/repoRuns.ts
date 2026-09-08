import type {
	RepoCommandsState,
	RepoRunExitPayload,
	RepoRunOutputPayload,
	RepoRunStarted,
	ServerEvent,
} from "@datagripe/contracts";
import { create } from "zustand";
import { wsClient } from "../api/ws";

/**
 * Commands a repository declares, and the runs of them
 * (docs/spec/repo-commands.md).
 *
 * Output arrives as workspace events rather than as a response, because
 * a run that starts a database outlives the request that began it and
 * affects everybody in the project — including the people who did not
 * press the button.
 */

export interface RunView {
	runId: string;
	connectionRef: string;
	name: string;
	argv: string[];
	cwd: string;
	/** Chunks in arrival order, stdout and stderr interleaved as they came. */
	output: Array<{ stream: "stdout" | "stderr"; chunk: string }>;
	exitCode: number | null;
	killed: boolean;
	reason: string | null;
	finished: boolean;
	startedAt: string;
}

/** Past this the pane keeps the tail: a seeding script is chatty. */
const MAX_CHUNKS = 2_000;

export interface RepoRunsState {
	commands: Record<string, RepoCommandsState>;
	loading: Record<string, boolean>;
	errors: Record<string, string>;
	runs: Record<string, RunView>;
	/** Most recent run per datasource, which is what the panel shows. */
	latestByRef: Record<string, string>;
	loadCommands: (connectionRef: string) => Promise<void>;
	approve: (connectionRef: string, approve: boolean) => Promise<void>;
	run: (connectionRef: string, name: string) => Promise<string | null>;
	cancel: (runId: string) => Promise<void>;
	handleEvent: (event: ServerEvent) => void;
	reset: () => void;
}

export const useRepoRunsStore = create<RepoRunsState>()((set, get) => ({
	commands: {},
	loading: {},
	errors: {},
	runs: {},
	latestByRef: {},

	async loadCommands(connectionRef) {
		set({ loading: { ...get().loading, [connectionRef]: true } });
		try {
			const state = await wsClient.request<RepoCommandsState>("repo.commands", {
				connectionRef,
			});
			const { [connectionRef]: _cleared, ...errors } = get().errors;
			set({ commands: { ...get().commands, [connectionRef]: state }, errors });
		} catch (cause) {
			set({
				errors: {
					...get().errors,
					[connectionRef]:
						cause instanceof Error ? cause.message : "Could not read run.yaml",
				},
			});
		} finally {
			const { [connectionRef]: _done, ...loading } = get().loading;
			set({ loading });
		}
	},

	async approve(connectionRef, approve) {
		const current = get().commands[connectionRef];
		if (current === undefined) {
			return;
		}
		try {
			// The hash goes back with the approval: what is approved has to
			// be what was on screen, not whatever the file says by the time
			// the request lands.
			const state = await wsClient.request<RepoCommandsState>("repo.trust", {
				connectionRef,
				commandsHash: current.commandsHash,
				approve,
				idempotencyKey: crypto.randomUUID(),
			});
			set({ commands: { ...get().commands, [connectionRef]: state } });
		} catch (cause) {
			set({
				errors: {
					...get().errors,
					[connectionRef]:
						cause instanceof Error ? cause.message : "Could not record that",
				},
			});
		}
	},

	async run(connectionRef, name) {
		try {
			const started = await wsClient.request<RepoRunStarted>("repo.run", {
				connectionRef,
				name,
				idempotencyKey: crypto.randomUUID(),
			});
			const view: RunView = {
				runId: started.runId,
				connectionRef,
				name: started.name,
				argv: started.argv,
				cwd: started.cwd,
				output: [],
				exitCode: null,
				killed: false,
				reason: null,
				finished: false,
				startedAt: new Date().toISOString(),
			};
			const { [connectionRef]: _cleared, ...errors } = get().errors;
			set({
				runs: { ...get().runs, [started.runId]: view },
				latestByRef: { ...get().latestByRef, [connectionRef]: started.runId },
				errors,
			});
			return started.runId;
		} catch (cause) {
			set({
				errors: {
					...get().errors,
					[connectionRef]:
						cause instanceof Error ? cause.message : "Could not start it",
				},
			});
			return null;
		}
	},

	async cancel(runId) {
		await wsClient.request("repo.run.cancel", { runId }).catch(() => {});
	},

	handleEvent(event) {
		if (event.topic === "repo.run.output") {
			const payload = event.payload as RepoRunOutputPayload;
			const run = get().runs[payload.runId];
			if (run === undefined) {
				return;
			}
			const output = [
				...run.output,
				{ stream: payload.stream, chunk: payload.chunk },
			];
			set({
				runs: {
					...get().runs,
					[payload.runId]: {
						...run,
						output:
							output.length > MAX_CHUNKS
								? output.slice(output.length - MAX_CHUNKS)
								: output,
					},
				},
			});
			return;
		}
		if (event.topic === "repo.run.exit") {
			const payload = event.payload as RepoRunExitPayload;
			const run = get().runs[payload.runId];
			if (run === undefined) {
				return;
			}
			set({
				runs: {
					...get().runs,
					[payload.runId]: {
						...run,
						exitCode: payload.exitCode,
						killed: payload.killed,
						reason: payload.reason,
						finished: true,
					},
				},
			});
			// A run that finished may have created the database the
			// datasource points at, so the command list is re-read: `run.yaml`
			// itself could have changed too.
			void get().loadCommands(run.connectionRef);
		}
	},

	reset: () =>
		set({
			commands: {},
			loading: {},
			errors: {},
			runs: {},
			latestByRef: {},
		}),
}));
