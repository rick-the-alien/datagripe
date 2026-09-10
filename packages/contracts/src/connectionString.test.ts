import { describe, expect, test } from "bun:test";
import {
	formatConnectionString,
	parseConnectionString,
	tlsModeSchema,
} from "./index";

/** Narrow to the ok branch, so a failure reads as the assertion it is. */
function parsed(input: string) {
	const result = parseConnectionString(input);
	if (!result.ok) {
		throw new Error(`expected a parse, got: ${result.error}`);
	}
	return result.parsed;
}

function refused(input: string): string {
	const result = parseConnectionString(input);
	if (result.ok) {
		throw new Error(`expected a refusal, got a parse of ${input}`);
	}
	return result.error;
}

describe("parseConnectionString", () => {
	test("reads the Neon string that prompted this", () => {
		// Verbatim shape from a Neon dashboard, password escaped as one
		// actually arrives.
		const { fields, applied, ignored } = parsed(
			"postgresql://neondb_owner:npg_a%40b%2Fc@ep-empty-fire-ag4i2d4n-pooler.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
		);

		expect(fields.adapter).toBe("postgres");
		expect(fields.host).toBe(
			"ep-empty-fire-ag4i2d4n-pooler.c-2.eu-central-1.aws.neon.tech",
		);
		expect(fields.port).toBe(5432);
		expect(fields.databaseName).toBe("neondb");
		expect(fields.username).toBe("neondb_owner");
		// The escapes are decoded exactly once.
		expect(fields.password).toBe("npg_a@b/c");
		expect(fields.tlsMode).toBe("require");

		expect(applied).toContain("sslmode");
		// Reported, not dropped and not stored somewhere inert.
		expect(ignored).toHaveLength(1);
		expect(ignored[0]?.key).toBe("channel_binding");
		expect(ignored[0]?.reason).toBe("unsupported");
		expect(ignored[0]?.detail).toContain("channel-binding");
	});

	test("names the datasource after the database and the host label", () => {
		expect(parsed("postgres://u:p@db.example.com/orders").fields.name).toBe(
			"orders on db",
		);
		// A local host adds nothing worth reading.
		expect(parsed("postgres://u:p@localhost:5432/orders").fields.name).toBe(
			"orders",
		);
	});

	test.each([
		["postgres://u:p@h/d", "postgres"],
		["postgresql://u:p@h/d", "postgres"],
		["mysql://u:p@h/d", "mysql"],
		["mariadb://u:p@h/d", "mysql"],
		["redis://h/0", "redis"],
		["rediss://h/0", "redis"],
	] as const)("maps the %s scheme to %s", (input, adapter) => {
		expect(parsed(input).fields.adapter).toBe(adapter);
	});

	test("falls back to the adapter's default port", () => {
		expect(parsed("postgres://u:p@h/d").fields.port).toBe(5432);
		expect(parsed("mysql://u:p@h/d").fields.port).toBe(3306);
		expect(parsed("redis://h/0").fields.port).toBe(6379);
		// An explicit port still wins.
		expect(parsed("postgres://u:p@h:6543/d").fields.port).toBe(6543);
	});

	test("assumes TLS when no sslmode is given", () => {
		// The form's own default is `disable`, which would fail against every
		// managed provider with an error that never mentions TLS. libpq's own
		// default, `prefer`, is not an option: Bun hangs on it.
		expect(parsed("postgres://u:p@h/d").fields.tlsMode).toBe("require");
		// An explicit mode is always honoured, including downwards.
		expect(parsed("postgres://u:p@h/d?sslmode=disable").fields.tlsMode).toBe(
			"disable",
		);
	});

	test.each(["prefer", "allow"])(
		"raises sslmode=%s to require and says why",
		(mode) => {
			// Measured: Bun has no negotiated fallback and hangs on both.
			// Raising fails visibly; lowering would quietly stop encrypting.
			const { fields, ignored } = parsed(`postgres://u:p@h/d?sslmode=${mode}`);
			expect(fields.tlsMode).toBe("require");
			const note = ignored.find((entry) => entry.key === "sslmode");
			expect(note?.detail).toContain("raised to require");
		},
	);

	test.each(tlsModeSchema.options)("carries sslmode=%s across", (mode) => {
		expect(parsed(`postgres://u:p@h/d?sslmode=${mode}`).fields.tlsMode).toBe(
			mode,
		);
	});

	test("rediss asserts TLS without an sslmode", () => {
		expect(parsed("rediss://h:6380/0").fields.tlsMode).toBe("require");
		expect(parsed("redis://h:6379/0").fields.tlsMode).toBe("require");
	});

	test("keeps an IPv6 host without its brackets", () => {
		const { fields } = parsed("postgres://u:p@[2001:db8::1]:5433/d");
		expect(fields.host).toBe("2001:db8::1");
		expect(fields.port).toBe(5433);
	});

	test("carries allowlisted params from application_name and options -c", () => {
		const { fields, applied } = parsed(
			"postgres://u:p@h/d?application_name=datagripe&options=-c%20search_path%3Dsales",
		);
		expect(fields.params).toEqual({
			application_name: "datagripe",
			search_path: "sales",
		});
		expect(applied).toContain("application_name");
		expect(applied).toContain("options:search_path");
	});

	test("reports statement_timeout rather than storing one the adapter overwrites", () => {
		const { fields, ignored } = parsed(
			"postgres://u:p@h/d?statement_timeout=5s",
		);
		expect(fields.params).toEqual({});
		expect(ignored[0]?.key).toBe("statement_timeout");
		expect(ignored[0]?.detail).toContain("per statement");
	});

	test("refuses to store a runtime parameter it does not know", () => {
		// An unrecognised one in the startup packet is a connect-time FATAL,
		// so carrying it would be a datasource that cannot connect at all.
		const { fields, ignored } = parsed(
			"postgres://u:p@h/d?options=-c%20wat%3D1",
		);
		expect(fields.params).toEqual({});
		expect(ignored[0]?.key).toBe("wat");
		expect(ignored[0]?.reason).toBe("unknown");
	});

	test("reports an options fragment it cannot carry", () => {
		const { ignored } = parsed(
			"postgres://u:p@h/d?options=--cluster-name%3Dwat",
		);
		expect(ignored).toHaveLength(1);
		expect(ignored[0]?.key).toBe("options");
		expect(ignored[0]?.reason).toBe("unsupported");
	});

	test("reports an unrecognised parameter as unknown rather than guessing", () => {
		// Supabase's pooler and Prisma both add their own.
		const { fields, ignored } = parsed(
			"postgres://u:p@h/d?pgbouncer=true&connection_limit=1",
		);
		expect(fields.params).toEqual({});
		expect(ignored.map((entry) => entry.key)).toEqual([
			"pgbouncer",
			"connection_limit",
		]);
		expect(ignored.every((entry) => entry.reason === "unknown")).toBe(true);
	});

	test("takes a sqlite path from either spelling", () => {
		expect(parsed("sqlite:./local.db").fields.databaseName).toBe("./local.db");
		expect(parsed("file:///srv/data/local.db").fields.databaseName).toBe(
			"/srv/data/local.db",
		);
		// Nothing to authenticate against, and no TLS to have an opinion on.
		const { fields } = parsed("sqlite:./local.db");
		expect(fields.host).toBe("");
		expect(fields.username).toBe("");
		expect(fields.tlsMode).toBe("disable");
	});

	test("copes with a missing database and a missing password", () => {
		const { fields } = parsed("postgres://reader@h:5432");
		expect(fields.databaseName).toBe("");
		expect(fields.username).toBe("reader");
		expect(fields.password).toBe("");
	});

	describe("refusals name what is accepted", () => {
		test("empty input", () => {
			expect(refused("   ")).toContain("Paste a connection string");
		});

		test("not a URL at all", () => {
			expect(refused("host=localhost port=5432")).toContain("postgres://");
		});

		test("a scheme we do not speak", () => {
			const error = refused("mongodb://u:p@h/d");
			expect(error).toContain("mongodb");
			expect(error).toContain("postgres://");
		});

		test("an sslmode that is not a mode", () => {
			expect(refused("postgres://u:p@h/d?sslmode=allowish")).toContain(
				"verify-full",
			);
		});

		test("a URL with no host", () => {
			expect(refused("postgres:///justadb")).toContain("No host");
		});

		test("a password with a stray % the provider did not escape", () => {
			// `decodeURIComponent` throws on this; unguarded it would crash a
			// field the user is still typing into.
			expect(refused("postgres://u:hunter%2@h/d")).toContain(
				"type it into the field",
			);
		});

		test("more than one host, which libpq allows and we do not", () => {
			expect(refused("postgres://u:p@h1:5432,h2:5433/db")).toContain(
				"postgres://",
			);
		});
	});
});

describe("formatConnectionString", () => {
	const fields = {
		adapter: "postgres" as const,
		host: "db.example.com",
		port: 5432,
		databaseName: "orders",
		username: "reader",
		tlsMode: "require" as const,
		params: {},
	};

	test("prints the user but never a secret", () => {
		// `PrintableConnection` has no password field at all, so a caller
		// cannot opt into one — passing `password` here is a compile error,
		// which is the real guarantee. This pins the shape the rail shows.
		expect(formatConnectionString(fields)).toBe(
			"postgres://reader@db.example.com:5432/orders?sslmode=require",
		);
	});

	test("round-trips everything but the password through the parser", () => {
		const back = parsed(formatConnectionString(fields)).fields;
		expect(back.adapter).toBe(fields.adapter);
		expect(back.host).toBe(fields.host);
		expect(back.port).toBe(fields.port);
		expect(back.databaseName).toBe(fields.databaseName);
		expect(back.username).toBe(fields.username);
		expect(back.tlsMode).toBe(fields.tlsMode);
	});

	test("brackets an IPv6 host so the port is not read as part of it", () => {
		expect(
			formatConnectionString({ ...fields, host: "2001:db8::1" }),
		).toContain("[2001:db8::1]:5432");
	});

	test("shows a sqlite connection as its path", () => {
		expect(
			formatConnectionString({
				...fields,
				adapter: "sqlite",
				databaseName: "./local.db",
			}),
		).toBe("sqlite:./local.db");
	});

	test("carries params back into the query", () => {
		expect(
			formatConnectionString({ ...fields, params: { search_path: "sales" } }),
		).toContain("search_path=sales");
	});
});
