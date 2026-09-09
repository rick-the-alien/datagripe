import type {
	Domain,
	DomainListResult,
	DomainTag,
	DomainTarget,
} from "@datagripe/contracts";
import { domainTargetKey } from "@datagripe/contracts";
import { create } from "zustand";
import { wsClient } from "../api/ws";

/**
 * Domain tags for the active datasource (docs/spec/domains.md).
 *
 * Loaded per `connectionRef` and kept keyed by it, because switching
 * datasources must not show one database's domains against another's
 * objects. That mistake would be invisible — the names would look
 * plausible — which is exactly why the store is not a single flat list.
 */

export type DomainsState = {
	/** connectionRef → domains, in the order the manager set. */
	byConnection: Record<string, Domain[]>;
	/** connectionRef → `kind:schema.name` → domain id. */
	tagsByConnection: Record<string, Record<string, string>>;
	/** Whether a load has completed, so "no domains" and "not asked" differ. */
	loaded: Record<string, boolean>;
	/** Group the tree by domain instead of by category. A view mode. */
	grouped: boolean;
	/**
	 * Show objects shelved in a hidden domain (docs/spec/domains.md
	 * "Hidden domains"). Off by default — that is the whole point of the
	 * shelf — and deliberately *not* persisted: it is a peek, and a peek
	 * that outlives the session stops being one.
	 */
	showHidden: boolean;
	load: (connectionRef: string) => Promise<void>;
	upsert: (
		connectionRef: string,
		domain: Omit<Domain, "id"> & { id?: string },
	) => Promise<Domain>;
	remove: (connectionRef: string, id: string) => Promise<number>;
	tag: (
		connectionRef: string,
		targets: DomainTarget[],
		domainId: string | null,
	) => Promise<void>;
	setGrouped: (grouped: boolean) => void;
	setShowHidden: (showHidden: boolean) => void;
	reset: () => void;
};

/*
 * Frozen empties for selectors reading a connection that has not loaded.
 *
 * A selector must return a referentially stable value: zustand compares
 * snapshots by identity, so `state.byConnection[ref] ?? []` hands React
 * a brand-new array on every render and it re-renders forever. The
 * failure mode is "Maximum update depth exceeded", which points at the
 * component rather than at the selector that caused it.
 */
export const NO_DOMAINS: readonly Domain[] = Object.freeze([]);
export const NO_TAGS: Readonly<Record<string, string>> = Object.freeze({});

function indexTags(tags: DomainTag[]): Record<string, string> {
	const index: Record<string, string> = {};
	for (const entry of tags) {
		index[domainTargetKey(entry.target)] = entry.domainId;
	}
	return index;
}

export const useDomainsStore = create<DomainsState>()((set, get) => ({
	byConnection: {},
	tagsByConnection: {},
	loaded: {},
	grouped: false,
	showHidden: false,

	async load(connectionRef) {
		try {
			const result = await wsClient.request<DomainListResult>("domain.list", {
				connectionRef,
			});
			set({
				byConnection: {
					...get().byConnection,
					[connectionRef]: result.domains,
				},
				tagsByConnection: {
					...get().tagsByConnection,
					[connectionRef]: indexTags(result.tags),
				},
				loaded: { ...get().loaded, [connectionRef]: true },
			});
		} catch {
			// An engine or a role that cannot read domains simply has none.
			// The tree still works; it just has no rail.
			set({ loaded: { ...get().loaded, [connectionRef]: true } });
		}
	},

	async upsert(connectionRef, domain) {
		const result = await wsClient.request<{ domain: Domain }>("domain.upsert", {
			connectionRef,
			...domain,
			idempotencyKey: crypto.randomUUID(),
		});
		await get().load(connectionRef);
		return result.domain;
	},

	async remove(connectionRef, id) {
		const result = await wsClient.request<{ untagged: number }>(
			"domain.delete",
			{ connectionRef, id },
		);
		await get().load(connectionRef);
		return result.untagged;
	},

	async tag(connectionRef, targets, domainId) {
		const result = await wsClient.request<DomainListResult>("domain.tag", {
			connectionRef,
			targets,
			domainId,
			idempotencyKey: crypto.randomUUID(),
		});
		set({
			byConnection: {
				...get().byConnection,
				[connectionRef]: result.domains,
			},
			tagsByConnection: {
				...get().tagsByConnection,
				[connectionRef]: indexTags(result.tags),
			},
		});
	},

	setGrouped(grouped) {
		set({ grouped });
	},

	setShowHidden(showHidden) {
		set({ showHidden });
	},

	reset() {
		set({ byConnection: {}, tagsByConnection: {}, loaded: {} });
	},
}));

/** The domain an object carries, or null. */
export function domainFor(
	connectionRef: string,
	target: DomainTarget,
	state: Pick<DomainsState, "byConnection" | "tagsByConnection">,
): Domain | null {
	const id = state.tagsByConnection[connectionRef]?.[domainTargetKey(target)];
	if (id === undefined) {
		return null;
	}
	return state.byConnection[connectionRef]?.find((d) => d.id === id) ?? null;
}

/** The CSS custom property for a palette slot. */
export function domainColourVar(colour: number): string {
	const slot = Math.min(8, Math.max(1, Math.round(colour)));
	return `var(--dg-domain-${slot})`;
}

/**
 * A tagged object's domain, or null.
 *
 * Selecting the *id* (a string) and the domain list (a stored array)
 * separately, then joining them in render, keeps both selectors stable.
 * Building `{ colour, name }` inside a selector returns a new object
 * every call and loops React forever.
 */
export function selectDomainId(
	connectionRef: string,
	targetKey: string,
): (state: DomainsState) => string | null {
	return (state) => state.tagsByConnection[connectionRef]?.[targetKey] ?? null;
}

export function selectDomains(
	connectionRef: string,
): (state: DomainsState) => readonly Domain[] {
	return (state) => state.byConnection[connectionRef] ?? NO_DOMAINS;
}

export function selectTags(
	connectionRef: string,
): (state: DomainsState) => Readonly<Record<string, string>> {
	return (state) => state.tagsByConnection[connectionRef] ?? NO_TAGS;
}
