import {
	ADAPTER_CAPABILITIES,
	type ConnectionAdapter,
	connectionAdapterSchema,
} from "./adapters";
import { type TlsMode, tlsModeSchema } from "./connections";

/**
 * Reading a database connection string into the fields the datasource form
 * already has, and writing one back out.
 *
 * A managed provider hands you a URL, not eight fields. Retyping it is
 * where the typos come from — a `-pooler` suffix dropped from a Neon host,
 * or a percent-escaped password transcribed literally — and every one of
 * those surfaces as an authentication failure that reads like the user's
 * mistake.
 *
 * The hard rule here is that nothing is discarded in silence. A URL
 * carries more than this product models, so every query parameter comes
 * back either applied, or named in `ignored` with the reason it could not
 * be. Quietly dropping `sslmode` would downgrade a connection somebody
 * asked to encrypt.
 */

/** Fields a connection string determines. Spread over a form draft. */
export interface ConnectionStringFields {
	adapter: ConnectionAdapter;
	name: string;
	host: string;
	port: number;
	databaseName: string;
	username: string;
	password: string;
	tlsMode: TlsMode;
	/** Postgres runtime parameters, from `application_name` and `options`. */
	params: Record<string, string>;
}

export interface IgnoredParam {
	key: string;
	value: string;
	/**
	 * `unsupported`: a real connection parameter this driver has no way to
	 * honour. `unknown`: not a parameter we recognise at all — usually an
	 * ORM's own invention.
	 */
	reason: "unsupported" | "unknown";
	/** Shown to the user, so it has to say why and not merely that. */
	detail: string;
}

export interface ParsedConnectionString {
	fields: ConnectionStringFields;
	/** Parameter keys that were applied, for the "we read this" summary. */
	applied: string[];
	ignored: IgnoredParam[];
}

export type ConnectionStringResult =
	| { ok: true; parsed: ParsedConnectionString }
	| { ok: false; error: string };

/** URL scheme → adapter. `rediss` and `mysqls` also assert TLS. */
const SCHEMES: Record<string, { adapter: ConnectionAdapter; tls?: TlsMode }> = {
	postgres: { adapter: "postgres" },
	postgresql: { adapter: "postgres" },
	mysql: { adapter: "mysql" },
	mariadb: { adapter: "mysql" },
	redis: { adapter: "redis" },
	rediss: { adapter: "redis", tls: "require" },
	sqlite: { adapter: "sqlite", tls: "disable" },
	file: { adapter: "sqlite", tls: "disable" },
};

const ACCEPTED_SCHEMES = Object.keys(SCHEMES)
	.map((scheme) => `${scheme}://`)
	.join(", ");

/**
 * Connection parameters that are real but unreachable from here, with the
 * reason. Being specific matters: "ignored" invites a bug report, whereas
 * "this driver has no channel-binding option" is an answer.
 */
const UNSUPPORTED: Record<string, string> = {
	channel_binding:
		"this driver has no channel-binding option. The connection is still encrypted by the TLS mode above; what is lost is the assertion that SCRAM was bound to that channel.",
	connect_timeout: "the connection timeout is fixed at 10 seconds.",
	sslrootcert: "a custom CA file cannot be supplied yet.",
	sslcert: "client certificates are not supported yet.",
	sslkey: "client certificates are not supported yet.",
	sslpassword: "client certificates are not supported yet.",
	sslcrl: "certificate revocation lists are not supported yet.",
	sslsni: "the SNI name cannot be overridden.",
	gssencmode: "GSSAPI encryption is not supported.",
	krbsrvname: "Kerberos is not supported.",
	passfile: "a password file cannot be read on your behalf.",
	hostaddr:
		"the host is taken from the URL itself; a separate address cannot be pinned.",
	target_session_attrs:
		"read/write session selection is not supported; use the provider's own endpoint for the role you want.",
	replication: "replication connections are not supported.",
};

/**
 * libpq modes this driver cannot perform, and what they become.
 *
 * `allow` and `prefer` both mean "try TLS, fall back to plaintext", and
 * Bun has no such path: measured against a non-TLS server, both hang
 * until the connection timeout rather than falling back. Raising them to
 * `require` is the safe direction — a wrong guess fails loudly instead of
 * silently sending credentials in the clear — and the user is told.
 */
const RAISED_TLS_MODES: Record<string, TlsMode> = {
	allow: "require",
	prefer: "require",
};

/**
 * Runtime parameters worth carrying across as-is.
 *
 * An allowlist rather than "anything we do not recognise", because these
 * ride in the startup packet and PostgreSQL answers an unrecognised one
 * with a FATAL at connect time. A parameter store that can stop a
 * datasource from connecting at all is worse than one that carries less.
 */
const RUNTIME_PARAMS = new Set(["application_name", "search_path"]);

/**
 * Accepted, stored, and then overwritten by the adapter before every
 * statement it runs — so it is reported for the same reason
 * `channel_binding` is. A value that is taken and quietly overridden is
 * the failure this module exists to avoid.
 */
const OVERRIDDEN_PARAMS: Record<string, string> = {
	statement_timeout:
		"the query timeout is set per statement from the server's own limits, so a value here would not survive.",
};

/**
 * `-c key=value` pairs out of libpq's `options`, which is how a URL
 * smuggles a `search_path` past a driver that has no field for it.
 * Anything in there that is not a `-c` assignment is handed back so the
 * caller can report it rather than guess.
 */
function parseOptions(raw: string): {
	params: Record<string, string>;
	leftovers: string[];
} {
	const params: Record<string, string> = {};
	const leftovers: string[] = [];
	const tokens = raw.split(/\s+/).filter((token) => token !== "");
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index] as string;
		// Both spellings: `-c k=v` and the run-together `-ck=v`.
		const assignment = token === "-c" ? tokens[++index] : token.slice(2);
		if (!token.startsWith("-c") || assignment === undefined) {
			leftovers.push(token);
			continue;
		}
		const equals = assignment.indexOf("=");
		if (equals <= 0) {
			leftovers.push(assignment);
			continue;
		}
		params[assignment.slice(0, equals)] = assignment.slice(equals + 1);
	}
	return { params, leftovers };
}

/**
 * `decodeURIComponent` that reports rather than throws.
 *
 * A password containing a literal `%` that the provider did not escape —
 * `hunter%2` is a valid password and an invalid escape — makes the
 * built-in throw a `URIError`. Left unguarded that surfaces as a crash in
 * a field the user is still typing into.
 */
function decode(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

/**
 * Whether a runtime parameter can be carried, or the reason it cannot.
 * `null` means "store it".
 */
function classifyRuntimeParam(
	name: string,
): Pick<IgnoredParam, "reason" | "detail"> | null {
	if (RUNTIME_PARAMS.has(name)) {
		return null;
	}
	const overridden = OVERRIDDEN_PARAMS[name];
	if (overridden !== undefined) {
		return { reason: "unsupported", detail: overridden };
	}
	return {
		reason: "unknown",
		detail:
			"not a runtime parameter this app carries. PostgreSQL refuses an unrecognised one at connect time, so it has been left out rather than risked.",
	};
}

/**
 * A name for the datasource, which a URL never carries and the form
 * requires. Host-and-database reads better than either alone, and the
 * provider-generated hostnames this exists for are long enough that the
 * first label is the only part anyone recognises.
 */
function deriveName(host: string, database: string): string {
	const label = host.split(".")[0] ?? host;
	if (label === "" || label === "localhost") {
		return database === "" ? "New datasource" : database;
	}
	return database === "" ? label : `${database} on ${label}`;
}

export function parseConnectionString(input: string): ConnectionStringResult {
	const trimmed = input.trim();
	if (trimmed === "") {
		return { ok: false, error: "Paste a connection string first." };
	}

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		return {
			ok: false,
			error: `Not a URL. Expected one of ${ACCEPTED_SCHEMES}`,
		};
	}

	const scheme = url.protocol.replace(/:$/, "").toLowerCase();
	const matched = SCHEMES[scheme];
	if (matched === undefined) {
		return {
			ok: false,
			error: `${scheme}:// is not a database this app speaks. Expected one of ${ACCEPTED_SCHEMES}`,
		};
	}
	const adapter = matched.adapter;
	const capabilities = ADAPTER_CAPABILITIES[adapter];

	// A file path, not a host: `sqlite:./local.db` and
	// `file:///srv/local.db` both mean the path, and neither has anything
	// to authenticate against.
	if (adapter === "sqlite") {
		const path = `${url.hostname}${url.pathname}`;
		const decoded = decode(path);
		if (path === "" || decoded === null) {
			return { ok: false, error: "No usable file path in that URL." };
		}
		return {
			ok: true,
			parsed: {
				fields: {
					adapter,
					name: deriveName("", path.split("/").pop() ?? path),
					host: "",
					port: 0,
					databaseName: decoded,
					username: "",
					password: "",
					tlsMode: "disable",
					params: {},
				},
				applied: [],
				ignored: [],
			},
		};
	}

	// `new URL` keeps the brackets on an IPv6 literal and leaves userinfo
	// percent-encoded — a Neon password full of %-escapes arrives here
	// still escaped, and passing it on unchanged is a wrong-password error
	// that looks like the user mistyped it.
	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (host === "") {
		return { ok: false, error: "No host in that URL." };
	}
	const database = decode(url.pathname.replace(/^\//, ""));
	const username = decode(url.username);
	const password = decode(url.password);
	if (database === null || username === null || password === null) {
		return {
			ok: false,
			error:
				"That URL contains a % that is not a valid escape — often a password the provider did not encode. Paste the string without the password and type it into the field.",
		};
	}

	const params: Record<string, string> = {};
	const applied: string[] = [];
	const ignored: IgnoredParam[] = [];
	let tlsMode: TlsMode | undefined = matched.tls;

	for (const [key, value] of url.searchParams) {
		const lower = key.toLowerCase();
		if (lower === "sslmode") {
			const raised = RAISED_TLS_MODES[value.toLowerCase()];
			if (raised !== undefined) {
				// Not a rounding error: this driver has no negotiated
				// fallback, so `prefer` would hang rather than downgrade.
				// Going up fails visibly against a server with no TLS;
				// going down would quietly stop encrypting against one
				// that has it.
				tlsMode = raised;
				applied.push(key);
				ignored.push({
					key,
					value,
					reason: "unsupported",
					detail: `this driver cannot negotiate TLS and fall back, so ${value} has been raised to require. If the server has no TLS, set the mode to disable yourself.`,
				});
				continue;
			}
			const parsedMode = tlsModeSchema.safeParse(value.toLowerCase());
			if (!parsedMode.success) {
				return {
					ok: false,
					error: `sslmode=${value} is not one of ${[...tlsModeSchema.options, ...Object.keys(RAISED_TLS_MODES)].join(", ")}.`,
				};
			}
			tlsMode = parsedMode.data;
			applied.push(key);
			continue;
		}
		if (lower === "options") {
			const { params: fromOptions, leftovers } = parseOptions(value);
			for (const [name, setting] of Object.entries(fromOptions)) {
				const note = classifyRuntimeParam(name);
				if (note === null) {
					params[name] = setting;
					applied.push(`${key}:${name}`);
				} else {
					ignored.push({ key: name, value: setting, ...note });
				}
			}
			for (const leftover of leftovers) {
				ignored.push({
					key,
					value: leftover,
					reason: "unsupported",
					detail:
						"only `-c name=value` settings can be carried across from `options`.",
				});
			}
			continue;
		}
		const runtimeNote = classifyRuntimeParam(lower);
		if (runtimeNote === null) {
			params[lower] = value;
			applied.push(key);
			continue;
		}
		if (runtimeNote.reason === "unsupported" && lower in OVERRIDDEN_PARAMS) {
			ignored.push({ key, value, ...runtimeNote });
			continue;
		}
		const unsupported = UNSUPPORTED[lower];
		if (unsupported !== undefined) {
			ignored.push({ key, value, reason: "unsupported", detail: unsupported });
			continue;
		}
		ignored.push({
			key,
			value,
			reason: "unknown",
			detail:
				"not a connection parameter this app recognises, so it has been left out rather than guessed at.",
		});
	}

	return {
		ok: true,
		parsed: {
			fields: {
				adapter,
				name: deriveName(host, database),
				host,
				// `url.port` is "" rather than undefined when absent.
				port:
					url.port === "" ? (capabilities.defaultPort ?? 0) : Number(url.port),
				databaseName: database,
				username,
				password,
				// A pasted URL is almost always a remote database, and the
				// form's `disable` default would fail against every managed
				// provider with an error that does not mention TLS. Absent an
				// `sslmode`, assume the encryption the host almost certainly
				// requires; it is visible in the field and easy to turn down.
				tlsMode: tlsMode ?? "require",
				params,
			},
			applied,
			ignored,
		},
	};
}

/** What can be printed. Deliberately not a password — see below. */
export interface PrintableConnection {
	adapter: ConnectionAdapter;
	host?: string;
	port?: number;
	databaseName?: string;
	username?: string;
	tlsMode?: TlsMode;
	params?: Record<string, string>;
}

/**
 * The inverse, for showing what the fields resolve to. Shares this module
 * with the parser so the preview and the thing that reads it back cannot
 * drift into two dialects.
 *
 * There is no way to ask for the password, and that is the point: this
 * exists to be read on screen, and an argument that switches a live
 * secret on is one careless call away from a rail somebody screenshots.
 * A type that cannot express it beats a comment asking you not to.
 */
export function formatConnectionString(fields: PrintableConnection): string {
	const scheme = connectionAdapterSchema.parse(fields.adapter);
	if (fields.adapter === "sqlite") {
		return `sqlite:${fields.databaseName || "…"}`;
	}
	const userinfo =
		fields.username === undefined || fields.username === ""
			? ""
			: `${encodeURIComponent(fields.username)}@`;
	const query = new URLSearchParams();
	if (fields.adapter !== "redis" && fields.tlsMode !== undefined) {
		query.set("sslmode", fields.tlsMode);
	}
	for (const [key, value] of Object.entries(fields.params ?? {})) {
		query.set(key, value);
	}
	const search = query.size === 0 ? "" : `?${query}`;
	// Brackets back on for an IPv6 literal, or the port reads as part of it.
	const host = fields.host?.includes(":") ? `[${fields.host}]` : fields.host;
	return `${scheme}://${userinfo}${host || "…"}:${fields.port ?? ""}/${fields.databaseName || "…"}${search}`;
}
