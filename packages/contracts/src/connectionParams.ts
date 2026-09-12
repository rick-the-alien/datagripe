import { z } from "zod";

/**
 * PostgreSQL runtime parameters carried on a datasource and sent in the
 * startup packet.
 *
 * `search_path` is the one that earns this: a datasource that points at a
 * team's schema should resolve unqualified names there, rather than
 * making every query say so. `application_name` comes free with the same
 * mechanism, and is what a DBA reading `pg_stat_activity` wants.
 *
 * An allowlist rather than a passthrough, and that is not caution for its
 * own sake: an unrecognised parameter in the startup packet is a
 * connect-time FATAL, not a warning. A free-form store would let a typo
 * produce a datasource that cannot connect at all, with an error naming
 * the parameter rather than the field it came from. Anything added here
 * has to be a deliberate, tested choice.
 *
 * These are not secrets. They are returned to every client in the project
 * alongside the rest of a datasource's metadata, and they are written
 * into `.datagripe/config.yaml` on export.
 */

export interface RuntimeParamInfo {
	/** Shown beside the field. Says what it changes, not what it is. */
	description: string;
}

export const RUNTIME_PARAMS: Record<string, RuntimeParamInfo> = {
	search_path: {
		description:
			"Schemas an unqualified name is looked up in, in order. Affects what a query means; the object tree still scopes itself from the breadcrumb.",
	},
	application_name: {
		description:
			"How this connection identifies itself in pg_stat_activity and the server log.",
	},
};

/**
 * Parameters this app recognises and deliberately will not carry, with
 * the reason — so they are refused by name rather than accepted and
 * quietly overridden.
 */
export const REFUSED_PARAMS: Record<string, string> = {
	statement_timeout:
		"the query timeout is set per statement from the deployment's own limits, so a value here would be overwritten before it took effect",
	default_transaction_read_only:
		"that is the `read only` toggle above; two controls for one thing means one of them is a decoration",
	client_encoding:
		"results are decoded assuming the server's default, so changing it would corrupt them",
};

const paramNameSchema = z.string().refine((name) => name in RUNTIME_PARAMS, {
	message: `not a runtime parameter DataGripe carries (${Object.keys(RUNTIME_PARAMS).join(", ")})`,
});

export const connectionParamsSchema = z
	.record(paramNameSchema, z.string().min(1).max(255))
	.default({});

export type ConnectionParams = z.infer<typeof connectionParamsSchema>;

/** Why a parameter cannot be carried, or `null` when it can. */
export function refuseParam(name: string): string | null {
	if (name in RUNTIME_PARAMS) {
		return null;
	}
	const refused = REFUSED_PARAMS[name];
	if (refused !== undefined) {
		return refused;
	}
	return "not a runtime parameter DataGripe carries. PostgreSQL refuses an unrecognised one at connect time, so it is left out rather than risked";
}
