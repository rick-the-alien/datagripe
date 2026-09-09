import { MCP_PROTOCOL_VERSION } from "@datagripe/contracts";
import { ErrorCodes } from "@datagripe/contracts/errors";
import { version as serverVersion } from "../../package.json";
import { ServiceError } from "../connections/service";
import { log } from "../log";
import { authenticate, type McpContext, type McpDeps } from "./context";
import { buildBriefing } from "./instructions";
import { listExposedFiles, readExposed } from "./knowledge";
import { callTool, isToolName, toolDefinitions } from "./tools";

/**
 * The MCP endpoint (docs/spec/mcp.md).
 *
 * Stateless JSON-RPC over one POST. No SSE, no session id, no
 * resumability — a tool call is one request and one answer, and the
 * seven methods below are the whole of what a client needs. The
 * alternative was `@modelcontextprotocol/sdk`, whose HTTP transport
 * wants Node `req`/`res` while `Bun.serve` hands us a `Request`; this
 * project already hand-rolls its migration runner and its WebSocket
 * protocol for the same reason.
 */

/** JSON-RPC codes, as the spec numbers them. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const HTTP_STATUS: Record<string, number> = {
	[ErrorCodes.Unauthorized]: 401,
	[ErrorCodes.Forbidden]: 403,
	[ErrorCodes.NotFound]: 404,
	[ErrorCodes.RateLimited]: 429,
};

interface RpcRequest {
	jsonrpc: "2.0";
	id?: string | number | null;
	method: string;
	params?: unknown;
}

function rpcError(
	id: string | number | null,
	code: number,
	message: string,
	status = 200,
): Response {
	return Response.json(
		{ jsonrpc: "2.0", id, error: { code, message } },
		{ status },
	);
}

function rpcResult(id: string | number | null, result: unknown): Response {
	return Response.json({ jsonrpc: "2.0", id, result });
}

/** A tool failure the model should read and act on, not a broken pipe. */
function toolError(id: string | number | null, message: string): Response {
	return rpcResult(id, {
		content: [{ type: "text", text: message }],
		isError: true,
	});
}

export type McpHandler = (
	request: Request,
	projectId: string,
) => Promise<Response>;

export function createMcpRoute(deps: McpDeps): McpHandler {
	return async (request, projectId) => {
		if (request.method !== "POST") {
			return new Response(
				JSON.stringify({
					error:
						"This MCP endpoint answers JSON-RPC over POST; it has no SSE stream.",
				}),
				{
					status: 405,
					headers: { allow: "POST", "content-type": "application/json" },
				},
			);
		}
		// A non-browser client sends no Origin at all, which is fine. One
		// that sends the wrong Origin is a browser being driven somewhere
		// it should not be (the MCP guidance on DNS rebinding).
		const origin = request.headers.get("origin");
		if (origin !== null && origin !== deps.config.WEB_ORIGIN) {
			return rpcError(null, INVALID_REQUEST, "Origin not allowed", 403);
		}

		let body: unknown;
		try {
			body = await request.json();
		} catch {
			return rpcError(null, PARSE_ERROR, "Body is not valid JSON");
		}
		if (Array.isArray(body)) {
			return rpcError(
				null,
				INVALID_REQUEST,
				"Batched requests are not supported — send one request per POST",
			);
		}
		const rpc = body as Partial<RpcRequest>;
		if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
			return rpcError(
				rpc.id ?? null,
				INVALID_REQUEST,
				"Expected a JSON-RPC 2.0 request with a method",
			);
		}
		const id = rpc.id ?? null;

		// Authentication before anything else, including initialize: there
		// is no anonymous discovery of a project's shape. Cookies are
		// ignored on this route on purpose — accepting the session cookie
		// would make a browser a usable client and a CSRF vector at once.
		let ctx: McpContext;
		try {
			ctx = await authenticate(
				deps,
				projectId,
				request.headers.get("authorization"),
			);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Not authenticated";
			const code =
				error instanceof ServiceError ? error.code : ErrorCodes.Unauthorized;
			log.audit("mcp.auth.failure", { projectId, code });
			return rpcError(id, INVALID_REQUEST, message, HTTP_STATUS[code] ?? 401);
		}

		// A notification has no id and takes no answer.
		if (rpc.id === undefined && rpc.method.startsWith("notifications/")) {
			return new Response(null, { status: 202 });
		}
		if (!deps.rateLimiter.take("mcp.tools.call", ctx.token.id)) {
			return rpcError(
				id,
				INTERNAL_ERROR,
				"Too many MCP requests from this token — slow down",
				429,
			);
		}

		try {
			return await route(deps, ctx, rpc.method, rpc.params, id);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!(error instanceof ServiceError)) {
				log.error("mcp call failed", { method: rpc.method, error: message });
				return rpcError(id, INTERNAL_ERROR, "Internal error");
			}
			// Everything a tool can be asked and fail at comes back as a
			// tool error, so the model can correct itself; a protocol
			// mistake is a JSON-RPC error, because it is not the model's to
			// fix.
			return rpc.method === "tools/call"
				? toolError(id, message)
				: rpcError(id, INVALID_PARAMS, message);
		}
	};
}

async function route(
	deps: McpDeps,
	ctx: McpContext,
	method: string,
	params: unknown,
	id: string | number | null,
): Promise<Response> {
	const args = (params ?? {}) as Record<string, unknown>;
	switch (method) {
		case "initialize": {
			const briefing = await buildBriefing(deps, ctx);
			const asked = args.protocolVersion;
			return rpcResult(id, {
				// Echo what the client asked for when we know it: the methods
				// here are the stable core of every revision so far.
				protocolVersion:
					typeof asked === "string" ? asked : MCP_PROTOCOL_VERSION,
				capabilities: { tools: {}, resources: {} },
				serverInfo: {
					name: `datagripe/${ctx.workspace.name}`,
					version: serverVersion,
				},
				instructions: briefing.text,
			});
		}

		case "ping":
			return rpcResult(id, {});

		case "tools/list":
			return rpcResult(id, { tools: toolDefinitions() });

		case "tools/call": {
			const name = args.name;
			if (typeof name !== "string" || !isToolName(name)) {
				return toolError(
					id,
					`No such tool: ${String(name)}. Call tools/list for the set.`,
				);
			}
			const payload = await callTool(deps, ctx, name, args.arguments);
			log.audit("mcp.tools.call", {
				workspaceId: ctx.workspace.id,
				tokenId: ctx.token.id,
				userId: ctx.userId,
				tool: name,
			});
			return rpcResult(id, {
				// Compact rather than indented: the reader is a context
				// window, and pretty-printing a two-hundred-row result spends
				// a third of it on whitespace.
				content: [{ type: "text", text: JSON.stringify(payload) }],
			});
		}

		case "resources/list": {
			const files = await listExposedFiles(deps, ctx);
			return rpcResult(id, {
				resources: files.map((file) => ({
					uri: file.uri,
					name: file.label,
					mimeType: file.label.toLowerCase().endsWith(".md")
						? "text/markdown"
						: "text/plain",
				})),
			});
		}

		case "resources/read": {
			const uri = args.uri;
			if (typeof uri !== "string") {
				throw new ServiceError(ErrorCodes.BadRequest, "uri is required");
			}
			const read = await readExposed(deps, ctx, uri, 0);
			return rpcResult(id, {
				contents: [
					{
						uri: read.uri,
						mimeType: read.uri.toLowerCase().endsWith(".md")
							? "text/markdown"
							: "text/plain",
						text: read.text,
					},
				],
			});
		}

		default:
			return rpcError(id, METHOD_NOT_FOUND, `Unsupported method: ${method}`);
	}
}
