import { wsClient } from "../api/ws";
import { createConnectionsStore } from "./connections";
import { useDocumentsStore } from "./documents";
import { createExecutionsStore } from "./executions";
import { createExplorerStore } from "./explorer";
import { useViewsStore } from "./views";

/** Live store singletons bound to the shared WebSocket client. */
export const useConnectionsStore = createConnectionsStore(wsClient.request);
export const useExecutionsStore = createExecutionsStore(wsClient.request);
export const useExplorerStore = createExplorerStore(wsClient.request);

export type { ConnectionDraft } from "./connections";
export { nodeKey } from "./explorer";

// Dev-only inspection seam for browser-driven debugging.
if (import.meta.env.DEV) {
	(window as unknown as Record<string, unknown>).__dg = {
		useConnectionsStore,
		useDocumentsStore,
		useExecutionsStore,
		useExplorerStore,
		useViewsStore,
	};
}
