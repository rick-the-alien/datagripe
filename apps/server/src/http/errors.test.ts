import { describe, expect, test } from "bun:test";
import { errorResponse } from "./errors";

describe("errorResponse", () => {
	test("returns the standardized ApiError shape with requestId header", async () => {
		const res = errorResponse(409, "CONFLICT", "Revision mismatch", "req-123", {
			currentRevision: 7,
		});

		expect(res.status).toBe(409);
		expect(res.headers.get("x-request-id")).toBe("req-123");

		const body = await res.json();
		expect(body).toEqual({
			error: {
				code: "CONFLICT",
				message: "Revision mismatch",
				requestId: "req-123",
				details: { currentRevision: 7 },
			},
		});
	});

	test("omits details when not provided", async () => {
		const res = errorResponse(404, "NOT_FOUND", "Not found", "req-1");
		const body = (await res.json()) as { error: { details?: unknown } };
		expect(body.error.details).toBeUndefined();
	});
});
