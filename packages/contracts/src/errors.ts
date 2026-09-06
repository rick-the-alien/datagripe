import { z } from "zod";

/**
 * Standardized error shape shared by HTTP responses and WebSocket messages.
 */
export const apiErrorSchema = z.object({
	error: z.object({
		code: z.string(),
		message: z.string(),
		requestId: z.string(),
		details: z.unknown().optional(),
	}),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

export const ErrorCodes = {
	BadRequest: "BAD_REQUEST",
	Unauthorized: "UNAUTHORIZED",
	Forbidden: "FORBIDDEN",
	NotFound: "NOT_FOUND",
	Conflict: "CONFLICT",
	RateLimited: "RATE_LIMITED",
	/** The target database refused the statement and said why. Its message
	 * is passed through verbatim — a constraint violation or a type cast
	 * failure is only actionable if you can read it. */
	TargetError: "TARGET_ERROR",
	Internal: "INTERNAL",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
