import {
	connectionCreateRequestSchema,
	connectionDeleteRequestSchema,
	connectionTestRequestSchema,
	connectionUpdateRequestSchema,
	executionCancelRequestSchema,
	executionStartRequestSchema,
	executionSubscribeRequestSchema,
	historyListRequestSchema,
	schemaChildrenRequestSchema,
} from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import type { ClientAction } from "@datagripe/contracts/ws";
import type { ConnectionsService } from "../connections/service";
import { ServiceError } from "../connections/service";
import { withIdempotency } from "../db/app/idempotency";
import type { AppDb } from "../db/app/pool";
import { listHistory } from "../execution/history";
import type { ExecutionRegistry } from "../execution/registry";

/**
 * Action dispatcher: validates each action's payload with the shared Zod
 * contracts and routes to the domain service. Returns the response
 * payload; throws ServiceError/ZodError for the handler to map.
 */
export type Dispatch = (
	action: ClientAction,
	payload: unknown,
) => Promise<unknown>;

export interface DispatcherDeps {
	appDb: AppDb;
	workspace: { id: string; name: string };
	userId: string;
	connections: ConnectionsService;
	executions: ExecutionRegistry;
}

export function createDispatcher(deps: DispatcherDeps): Dispatch {
	const { appDb, workspace, connections, executions, userId } = deps;

	return async (action, payload) => {
		switch (action) {
			case "workspace.open":
				return {
					workspace,
					connections: await connections.listConnections(),
				};

			case "connection.create": {
				const request = connectionCreateRequestSchema.parse(payload);
				return withIdempotency(
					appDb,
					workspace.id,
					action,
					request.idempotencyKey,
					() => connections.createConnection(request),
				);
			}

			case "connection.update": {
				const request = connectionUpdateRequestSchema.parse(payload);
				return withIdempotency(
					appDb,
					workspace.id,
					action,
					request.idempotencyKey,
					() => connections.updateConnection(request),
				);
			}

			case "connection.delete": {
				const request = connectionDeleteRequestSchema.parse(payload);
				return withIdempotency(
					appDb,
					workspace.id,
					action,
					request.idempotencyKey,
					() => connections.deleteConnection(request.id),
				);
			}

			case "connection.test": {
				const request = connectionTestRequestSchema.parse(payload);
				return connections.testConnection(request);
			}

			case "schema.children": {
				const request = schemaChildrenRequestSchema.parse(payload);
				return {
					nodes: await connections.schemaChildren(
						request.connectionId,
						request.path,
						request.refresh,
					),
				};
			}

			case "execution.start": {
				const request = executionStartRequestSchema.parse(payload);
				return withIdempotency(
					appDb,
					workspace.id,
					action,
					request.idempotencyKey,
					() => executions.start(request),
				);
			}

			case "execution.cancel": {
				const request = executionCancelRequestSchema.parse(payload);
				return executions.cancel(request.executionId);
			}

			case "execution.subscribe": {
				const request = executionSubscribeRequestSchema.parse(payload);
				return {
					events: executions.replay(request.executionId, request.afterSequence),
				};
			}

			case "history.list": {
				const request = historyListRequestSchema.parse(payload);
				return listHistory(appDb, userId, request.limit, request.offset, (id) =>
					connections.predefinedName(id),
				);
			}

			default:
				throw new ServiceError(
					ErrorCodes.NotFound,
					`Action '${action}' is not implemented yet`,
				);
		}
	};
}
