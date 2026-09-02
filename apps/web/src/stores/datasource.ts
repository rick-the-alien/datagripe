import type { ConnectionAdapter } from "@datagripe/contracts";
import { create } from "zustand";

/**
 * Active datasource + namespace selection (docs/brand/mocks/
 * datasource-selector.html): the sidebar tree is scoped to exactly one
 * datasource and one namespace; switching either rebuilds the tree.
 * Selection is per connection so switching back restores the namespace.
 */

/** Second breadcrumb segment label, per engine (never hard-coded
 * "schema" — wrong three times out of four). */
export const NAMESPACE_LABELS: Record<ConnectionAdapter, string> = {
	postgres: "schema",
	mysql: "database",
	sqlite: "file",
	redis: "keyspace",
};

/** Neutral engine monograms for the breadcrumb chip (Raised, never
 * accent colours — accents belong to the project class). */
export const ENGINE_CHIPS: Record<ConnectionAdapter, string> = {
	postgres: "P",
	mysql: "M",
	sqlite: "S",
	redis: "R",
};

export type DatasourceState = {
	activeConnectionId: string | null;
	/** connection id → chosen namespace (schema / database / keyspace). */
	namespaceByConnection: Record<string, string>;
	setActive: (connectionId: string) => void;
	setNamespace: (connectionId: string, namespace: string) => void;
	reset: () => void;
};

export const useDatasourceStore = create<DatasourceState>()((set) => ({
	activeConnectionId: null,
	namespaceByConnection: {},
	setActive: (connectionId) => set({ activeConnectionId: connectionId }),
	setNamespace: (connectionId, namespace) =>
		set({
			namespaceByConnection: {
				...useDatasourceStore.getState().namespaceByConnection,
				[connectionId]: namespace,
			},
		}),
	reset: () => set({ activeConnectionId: null, namespaceByConnection: {} }),
}));

/** Engine default namespace once the list is known: public/main/db0 win
 * where present, otherwise the first entry. */
export function defaultNamespace(names: string[]): string | undefined {
	if (names.length === 0) {
		return undefined;
	}
	for (const preferred of ["public", "main", "db0"]) {
		if (names.includes(preferred)) {
			return preferred;
		}
	}
	return names[0];
}
