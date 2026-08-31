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
	Internal: "INTERNAL",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
