import type { ConnectionStringFields } from "@datagripe/contracts";
import type { ConnectionDraft } from "../stores/runtime";

/**
 * What a parsed connection string does to a draft.
 *
 * Separate from the form and pure, because the interesting part is not
 * the input box — it is deciding which of the user's existing answers a
 * paste is allowed to overwrite. Every clause below is a judgement, and
 * each one has a test.
 */
export function applyParsed(
	draft: ConnectionDraft,
	fields: ConnectionStringFields,
): ConnectionDraft {
	return {
		...draft,
		adapter: fields.adapter,
		host: fields.host,
		port: fields.port,
		databaseName: fields.databaseName,
		username: fields.username,
		password: fields.password,
		tlsMode: fields.tlsMode,
		/**
		 * Replaced, not merged. A merge would leave a `search_path` from an
		 * earlier paste attached to a different database, which is the kind
		 * of leftover nobody thinks to look for.
		 */
		params: fields.params,
		/**
		 * A name the user already typed survives. The derived one is a
		 * guess from the host and database, and overwriting a deliberate
		 * "Prod (read replica)" with "neondb on ep-empty-fire" would be
		 * the paste destroying the one field it knows least about.
		 */
		name: draft.name.trim() === "" ? fields.name : draft.name,
		/**
		 * `readOnly` and `showAllSchemas` are behaviour, not connection: a
		 * URL has no opinion about either, so a paste must not reset the
		 * safe default somebody deliberately left on.
		 */
	};
}
