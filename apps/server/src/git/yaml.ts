import { ErrorCodes } from "@datagripe/contracts/errors";
import { parse, stringify } from "yaml";
import { ServiceError } from "../connections/service";

/**
 * The one YAML configuration for everything in `.datagripe/`
 * (docs/spec/git-datasources.md).
 *
 * An export that churns is an export nobody commits, and the
 * determinism rules from docs/spec/domains.md carry over with one
 * addition: **the serialiser configuration is fixed**.
 *
 * `lineWidth: 0` is the important one. Line folding is the trap: a
 * description that grows by one character reflows a paragraph and puts
 * a twelve-line diff in front of somebody who changed a word. Anchors
 * and aliases are off for the same reason — a repeated object turning
 * into `*ref1` halfway down a file is a diff nobody can read.
 *
 * Key order is the order of the object handed in, not alphabetical, so
 * `version` stays at the top where a reader looks for it.
 */
const STRINGIFY_OPTIONS = {
	indent: 2,
	lineWidth: 0,
	minContentWidth: 0,
	singleQuote: false,
	aliasDuplicateObjects: false,
	// Block style throughout: `{a: 1}` is valid YAML and unreadable in a
	// diff, which is the only place these files are ever read closely.
	defaultKeyType: null,
	defaultStringType: "PLAIN" as const,
};

/** Serialise, with a header comment and exactly one trailing newline. */
export function toYaml(value: unknown, header?: string[]): string {
	const body = stringify(value, STRINGIFY_OPTIONS);
	const comment =
		header === undefined || header.length === 0
			? ""
			: `${header.map((line) => (line === "" ? "#" : `# ${line}`)).join("\n")}\n`;
	return `${comment}${body.endsWith("\n") ? body : `${body}\n`}`;
}

/**
 * Parse, with the file named in the error. A YAML syntax error from the
 * library says "at line 4, column 3" and not which of three files it
 * was reading.
 */
export function fromYaml(text: string, file: string): unknown {
	try {
		return parse(text);
	} catch (error) {
		throw new ServiceError(
			ErrorCodes.BadRequest,
			`${file} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * Keys DataGripe does not know, kept aside so a write can put them back.
 *
 * An older DataGripe must not silently delete a newer one's settings
 * when it rewrites the file, and a person's own `# notes:` block is
 * theirs. Only the top level is preserved: an unknown key *inside* a
 * block DataGripe owns is almost always a typo, and the schemas reject
 * those.
 */
export function unknownTopLevel(
	parsed: unknown,
	known: string[],
): Record<string, unknown> {
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {};
	}
	const extra: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (!known.includes(key)) {
			extra[key] = value;
		}
	}
	return extra;
}
