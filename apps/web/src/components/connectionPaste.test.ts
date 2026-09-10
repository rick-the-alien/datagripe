import { describe, expect, test } from "bun:test";
import type { ConnectionStringFields } from "@datagripe/contracts";
import type { ConnectionDraft } from "../stores/runtime";
import { applyParsed } from "./connectionPaste";

const draft: ConnectionDraft = {
	adapter: "postgres",
	name: "",
	host: "localhost",
	port: 5432,
	databaseName: "",
	username: "",
	password: "",
	tlsMode: "disable",
	readOnly: true,
	showAllSchemas: false,
};

const fields: ConnectionStringFields = {
	adapter: "postgres",
	name: "neondb on ep-empty-fire",
	host: "ep-empty-fire.eu-central-1.aws.neon.tech",
	port: 5432,
	databaseName: "neondb",
	username: "neondb_owner",
	password: "npg_secret",
	tlsMode: "require",
};

describe("applyParsed", () => {
	test("fills every connection field the string spoke about", () => {
		const next = applyParsed(draft, fields);
		expect(next.host).toBe(fields.host);
		expect(next.databaseName).toBe("neondb");
		expect(next.username).toBe("neondb_owner");
		expect(next.password).toBe("npg_secret");
		// The form's own default is `disable`; the paste must win.
		expect(next.tlsMode).toBe("require");
	});

	test("takes the derived name only when the field is empty", () => {
		expect(applyParsed(draft, fields).name).toBe("neondb on ep-empty-fire");
		// A deliberate name is the one field a paste knows least about.
		const named = { ...draft, name: "Prod (read replica)" };
		expect(applyParsed(named, fields).name).toBe("Prod (read replica)");
		// Whitespace is not a name.
		expect(applyParsed({ ...draft, name: "   " }, fields).name).toBe(
			"neondb on ep-empty-fire",
		);
	});

	test("leaves behaviour toggles alone", () => {
		// A URL has no opinion on either, so a paste must not reset a safe
		// default somebody deliberately chose.
		const chosen = { ...draft, readOnly: false, showAllSchemas: true };
		const next = applyParsed(chosen, fields);
		expect(next.readOnly).toBe(false);
		expect(next.showAllSchemas).toBe(true);
	});

	test("switches the engine to match the scheme", () => {
		const next = applyParsed(draft, {
			...fields,
			adapter: "mysql",
			port: 3306,
		});
		expect(next.adapter).toBe("mysql");
		expect(next.port).toBe(3306);
	});

	test("clears a password the string did not carry", () => {
		// Otherwise a second paste of a password-free URL silently keeps the
		// first one's secret against a different host.
		const withSecret = { ...draft, password: "from-an-earlier-paste" };
		const next = applyParsed(withSecret, { ...fields, password: "" });
		expect(next.password).toBe("");
	});
});
