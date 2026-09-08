import type { GitCommandResult, GitStatusResult } from "@datagripe/contracts";
import { create } from "zustand";
import { wsClient } from "../api/ws";

/**
 * The repository section's state (docs/spec/git-datasources.md
 * "The repository section").
 *
 * The rule this store exists to enforce: **nothing polls.** There is no
 * interval, no refresh-on-focus and no fetch-on-render. `load` is called
 * when the section mounts, when `refresh` is pressed, and after an
 * operation this section ran. A status call is a `git` process, and one
 * per second per open workspace is a bad way to spend a laptop.
 *
 * Selection is here rather than in the component so collapsing the
 * section — which unmounts it — does not lose what you had ticked.
 */

export interface RepoState {
	status: Record<string, GitStatusResult>;
	loading: Record<string, boolean>;
	errors: Record<string, string>;
	/** Ticked paths per datasource. Nothing is ticked by default. */
	selected: Record<string, string[]>;
	/** Last operation's transcript, shown verbatim under the buttons. */
	output: Record<string, GitCommandResult>;
	busy: Record<string, string>;
	load: (connectionRef: string) => Promise<void>;
	toggle: (connectionRef: string, path: string) => void;
	selectAll: (connectionRef: string, on: boolean) => void;
	commit: (connectionRef: string, message: string) => Promise<void>;
	push: (connectionRef: string, setUpstream: boolean) => Promise<void>;
	pull: (connectionRef: string) => Promise<void>;
	reset: () => void;
}

/** Rows already staged when the section loaded arrive ticked. */
function initialSelection(status: GitStatusResult): string[] {
	return status.entries
		.filter((entry) => entry.staged)
		.map((entry) => entry.path);
}

export const useRepoStore = create<RepoState>()((set, get) => ({
	status: {},
	loading: {},
	errors: {},
	selected: {},
	output: {},
	busy: {},

	async load(connectionRef) {
		if (get().loading[connectionRef] === true) {
			return;
		}
		set({ loading: { ...get().loading, [connectionRef]: true } });
		try {
			const status = await wsClient.request<GitStatusResult>("git.status", {
				connectionRef,
			});
			const { [connectionRef]: _cleared, ...errors } = get().errors;
			// Keep a tick the person made on a file that is still changed;
			// re-ticking after every refresh would make the button useless.
			const present = new Set(status.entries.map((entry) => entry.path));
			const kept = (get().selected[connectionRef] ?? []).filter((path) =>
				present.has(path),
			);
			set({
				status: { ...get().status, [connectionRef]: status },
				errors,
				selected: {
					...get().selected,
					[connectionRef]:
						get().selected[connectionRef] === undefined
							? initialSelection(status)
							: [...new Set([...kept, ...initialSelection(status)])],
				},
			});
		} catch (cause) {
			set({
				errors: {
					...get().errors,
					[connectionRef]:
						cause instanceof Error ? cause.message : "git status failed",
				},
			});
		} finally {
			const { [connectionRef]: _done, ...loading } = get().loading;
			set({ loading });
		}
	},

	toggle(connectionRef, path) {
		const current = get().selected[connectionRef] ?? [];
		set({
			selected: {
				...get().selected,
				[connectionRef]: current.includes(path)
					? current.filter((entry) => entry !== path)
					: [...current, path],
			},
		});
	},

	selectAll(connectionRef, on) {
		set({
			selected: {
				...get().selected,
				[connectionRef]: on
					? (get().status[connectionRef]?.entries ?? []).map(
							(entry) => entry.path,
						)
					: [],
			},
		});
	},

	async commit(connectionRef, message) {
		await runOperation(set, get, connectionRef, "commit", () =>
			wsClient.request<GitCommandResult>("git.commit", {
				connectionRef,
				message,
				// Exactly what was ticked. Never `-A`, never a path nobody
				// named — the guarantee from docs/spec/domains.md "Committing",
				// in the form the sidebar needs.
				paths: get().selected[connectionRef] ?? [],
				idempotencyKey: crypto.randomUUID(),
			}),
		);
		// A successful commit empties the selection: those files are in the
		// history now, and leaving them ticked invites committing them again.
		if (get().output[connectionRef]?.exitCode === 0) {
			set({ selected: { ...get().selected, [connectionRef]: [] } });
		}
	},

	async push(connectionRef, setUpstream) {
		await runOperation(set, get, connectionRef, "push", () =>
			wsClient.request<GitCommandResult>("git.push", {
				connectionRef,
				setUpstream,
				idempotencyKey: crypto.randomUUID(),
			}),
		);
	},

	async pull(connectionRef) {
		await runOperation(set, get, connectionRef, "pull", () =>
			wsClient.request<GitCommandResult>("git.pull", {
				connectionRef,
				idempotencyKey: crypto.randomUUID(),
			}),
		);
	},

	reset: () =>
		set({
			status: {},
			loading: {},
			errors: {},
			selected: {},
			output: {},
			busy: {},
		}),
}));

/**
 * One operation: mark busy, run it, keep git's answer, and take the
 * status that came back with it so the list never goes stale behind a
 * transcript that says it changed.
 */
async function runOperation(
	set: (partial: Partial<RepoState>) => void,
	get: () => RepoState,
	connectionRef: string,
	label: string,
	action: () => Promise<GitCommandResult>,
): Promise<void> {
	set({ busy: { ...get().busy, [connectionRef]: label } });
	try {
		const result = await action();
		const { [connectionRef]: _cleared, ...errors } = get().errors;
		set({
			output: { ...get().output, [connectionRef]: result },
			status: { ...get().status, [connectionRef]: result.status },
			errors,
		});
	} catch (cause) {
		set({
			errors: {
				...get().errors,
				[connectionRef]:
					cause instanceof Error ? cause.message : `git ${label} failed`,
			},
		});
	} finally {
		const { [connectionRef]: _done, ...busy } = get().busy;
		set({ busy });
	}
}
