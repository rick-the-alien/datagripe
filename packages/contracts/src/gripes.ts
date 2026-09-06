import { z } from "zod";

/**
 * Gripe contracts (docs/spec/gripes.md). These are the wire types: a
 * finding crosses the socket when the server evaluates an
 * execution-input rule, and the client renders it.
 *
 * There is deliberately no prose here. A finding carries a rule id and
 * facts; the sentence is chosen at render time from the reader's
 * attitude level, which the server has no business knowing.
 */

/**
 * How bad the finding is — not how rudely it is phrased. Three, because
 * `tokens.css` defines exactly three severity accents and the gripe-row
 * treatment is built on them.
 */
export const gripeSeveritySchema = z.enum(["blocker", "warning", "style"]);

export type GripeSeverity = z.infer<typeof gripeSeveritySchema>;

/** Ordered worst-first, for sorting a panel. */
export const GRIPE_SEVERITIES: GripeSeverity[] = [
	"blocker",
	"warning",
	"style",
];

/**
 * How rudely a finding is phrased — not how bad it is. Postgres
 * severities, because of course they are (brand-system.md "Attitude
 * levels").
 */
export const attitudeLevelSchema = z.enum([
	"notice",
	"warning",
	"fatal",
	"panic",
]);

export type AttitudeLevel = z.infer<typeof attitudeLevelSchema>;

export const ATTITUDE_LEVELS: AttitudeLevel[] = [
	"notice",
	"warning",
	"fatal",
	"panic",
];

/** `warning` is the default and stays the default. */
export const DEFAULT_ATTITUDE: AttitudeLevel = "warning";

/**
 * Where to point at. A document range for a statement rule, a relation
 * for a structural one, an execution for a runtime one.
 */
export const gripeLocationSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("document"),
		documentId: z.string().min(1).max(255),
		/** Offsets into the document text. */
		start: z.number().int().nonnegative(),
		end: z.number().int().nonnegative(),
	}),
	z.object({
		kind: z.literal("object"),
		connectionId: z.string().min(1).max(255),
		schema: z.string().min(1).max(255),
		name: z.string().min(1).max(1024),
		/** Which object-view tab this annotates, when it is tab-specific. */
		tab: z.string().max(40).optional(),
	}),
	z.object({
		kind: z.literal("execution"),
		executionId: z.string().min(1).max(255),
	}),
]);

export type GripeLocation = z.infer<typeof gripeLocationSchema>;

/**
 * Named values the wording interpolates — never pre-formatted prose.
 * `{ rows: 41203882, column: "status" }`, not "41M rows and no index on
 * status". This is what makes attitude a presentation layer rather than
 * four parallel analyses.
 */
export const gripeFactsSchema = z.record(
	z.string().min(1).max(40),
	z.union([z.string().max(500), z.number()]),
);

export type GripeFacts = z.infer<typeof gripeFactsSchema>;

export const findingSchema = z.object({
	/** `<subject>.<problem>`, and a public contract — see the spec. */
	ruleId: z.string().min(1).max(80),
	severity: gripeSeveritySchema,
	at: gripeLocationSchema,
	facts: gripeFactsSchema,
});

export type Finding = z.infer<typeof findingSchema>;

/** Dismissal scope, coarsest last (docs/spec/gripes.md "Dismissal"). */
export const dismissalScopeSchema = z.enum(["occurrence", "target", "project"]);

export type DismissalScope = z.infer<typeof dismissalScopeSchema>;
