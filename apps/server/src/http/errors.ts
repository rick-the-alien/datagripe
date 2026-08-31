import type { ApiError, ErrorCode } from "@datagripe/contracts/errors";

/**
 * Build a standardized JSON error response. Every error carries a
 * requestId so client reports can be correlated with server logs.
 */
export function errorResponse(
	status: number,
	code: ErrorCode,
	message: string,
	requestId: string,
	details?: unknown,
): Response {
	const body: ApiError = {
		error: {
			code,
			message,
			requestId,
			...(details !== undefined ? { details } : {}),
		},
	};
	return Response.json(body, {
		status,
		headers: { "x-request-id": requestId },
	});
}
