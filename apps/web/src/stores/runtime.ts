import { wsClient } from "../api/ws";
import { createConnectionsStore } from "./connections";
import { createExplorerStore } from "./explorer";

/** Live store singletons bound to the shared WebSocket client. */
export const useConnectionsStore = createConnectionsStore(wsClient.request);
export const useExplorerStore = createExplorerStore(wsClient.request);

export type { ConnectionDraft } from "./connections";
export { nodeKey } from "./explorer";
