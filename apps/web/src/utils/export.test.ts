import { describe, expect, test } from "bun:test";
import { toCsv, toJson } from "./export";

const COLUMNS = [
	{ name: "id", dataType: "integer" },
	{ name: "note", dataType: "text" },
];

describe("toCsv", () => {
	test("escapes commas, quotes, and newlines", () => {
		const csv = toCsv(COLUMNS, [
			[1, 'say "hi"'],
			[2, "a,b"],
			[3, "line\nbreak"],
		]);
		expect(csv).toBe(
			'id,note\r\n1,"say ""hi"""\r\n2,"a,b"\r\n3,"line\nbreak"\r\n',
		);
	});

	test("null cells are empty, objects are JSON", () => {
		const csv = toCsv(COLUMNS, [[1, null]]);
		expect(csv).toBe("id,note\r\n1,\r\n");
		const obj = toCsv(COLUMNS, [[1, { a: 1 }]]);
		expect(obj).toBe('id,note\r\n1,"{""a"":1}"\r\n');
	});
});

describe("toJson", () => {
	test("rows become objects keyed by column", () => {
		const json = toJson(COLUMNS, [
			[1, "x"],
			[2, null],
		]);
		expect(JSON.parse(json)).toEqual([
			{ id: 1, note: "x" },
			{ id: 2, note: null },
		]);
	});
});
