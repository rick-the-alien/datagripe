import { describe, expect, test } from "bun:test";
import type { ObjectColumn, ObjectConstraint } from "@datagripe/contracts";
import {
	formatAgo,
	formatBytes,
	formatCount,
	reconstructCreateTable,
	statTiles,
} from "./format";

function column(
	name: string,
	overrides: Partial<ObjectColumn> = {},
): ObjectColumn {
	return {
		name,
		dataType: "text",
		nullable: true,
		defaultExpr: null,
		primaryKey: false,
		comment: null,
		...overrides,
	};
}

describe("formatBytes", () => {
	test("stays in bytes below a kilobyte", () => {
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(0)).toBe("0 B");
	});

	test("keeps one decimal below ten and rounds above", () => {
		expect(formatBytes(1_288_490_188)).toBe("1.2 GB");
		expect(formatBytes(536_870_912)).toBe("512 MB");
	});

	test("null and non-finite input produce no tile", () => {
		expect(formatBytes(null)).toBeNull();
		expect(formatBytes(undefined)).toBeNull();
		expect(formatBytes(Number.NaN)).toBeNull();
	});
});

describe("formatCount", () => {
	test("groups thousands", () => {
		expect(formatCount(41_203_882)).toBe("41,203,882");
	});

	test("null stays null", () => {
		expect(formatCount(null)).toBeNull();
	});
});

describe("formatAgo", () => {
	const now = Date.parse("2026-09-05T12:00:00.000Z");

	test("seconds, minutes, hours and days", () => {
		expect(formatAgo("2026-09-05T11:59:30.000Z", now)).toBe("30s ago");
		expect(formatAgo("2026-09-05T11:30:00.000Z", now)).toBe("30m ago");
		expect(formatAgo("2026-09-05T08:00:00.000Z", now)).toBe("4h ago");
		expect(formatAgo("2026-09-01T12:00:00.000Z", now)).toBe("4d ago");
	});

	test("accepts a Date as well as a string", () => {
		expect(formatAgo(new Date("2026-09-05T08:00:00.000Z"), now)).toBe("4h ago");
	});

	test("unparseable and missing timestamps produce no tile", () => {
		expect(formatAgo(null, now)).toBeNull();
		expect(formatAgo("not a date", now)).toBeNull();
	});
});

describe("statTiles", () => {
	test("drops the tiles an engine could not fill", () => {
		expect(
			statTiles([
				["live rows", "10"],
				["heap", null],
				["indexes", "1.2 GB"],
			]),
		).toEqual([
			{ label: "live rows", value: "10" },
			{ label: "indexes", value: "1.2 GB" },
		]);
	});
});

describe("reconstructCreateTable", () => {
	const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

	test("renders columns, nullability, defaults and constraints", () => {
		const constraints: ObjectConstraint[] = [
			{
				name: "payments_pkey",
				type: "primary key",
				definition: "PRIMARY KEY (id)",
			},
		];
		const ddl = reconstructCreateTable({
			quote,
			schema: "public",
			name: "payments",
			columns: [
				column("id", {
					dataType: "integer",
					nullable: false,
					defaultExpr: "nextval('payments_id_seq')",
				}),
				column("note"),
			],
			constraints,
			indexStatements: ["CREATE INDEX idx_note ON public.payments (note);"],
		});
		expect(ddl).toBe(
			[
				'create table "public"."payments" (',
				`  "id"   integer not null default nextval('payments_id_seq'),`,
				'  "note" text,',
				'  constraint "payments_pkey" PRIMARY KEY (id)',
				");",
				"",
				"CREATE INDEX idx_note ON public.payments (note);",
			].join("\n"),
		);
	});

	test("a table with no constraints or indexes still closes cleanly", () => {
		const ddl = reconstructCreateTable({
			quote,
			schema: "app",
			name: "t",
			columns: [column("a")],
			constraints: [],
			indexStatements: [],
		});
		expect(ddl).toBe('create table "app"."t" (\n  "a" text\n);');
	});
});
