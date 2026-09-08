import type { RepoDomainsFile } from "@datagripe/contracts";
import { toYaml } from "./yaml";

/**
 * `.datagripe/domains.yaml`, serialised
 * (docs/spec/git-datasources.md "domains.yaml").
 *
 * Its own module so the exporter — which is deliberately free of
 * filesystem access, because that is what makes the determinism rules
 * testable without a temporary directory — can render it without
 * pulling in the reader.
 *
 * Every field is written explicitly and in a fixed order rather than
 * handing the object straight to the serialiser. An export that churns
 * is an export nobody commits, and key order arriving from whatever
 * shape the caller happened to build is exactly how that starts.
 */
export function renderDomainsFile(value: RepoDomainsFile): string {
	return toYaml(
		{
			version: value.version,
			connection: {
				ref: value.connection.ref,
				name: value.connection.name,
				engine: value.connection.engine,
			},
			domains: value.domains.map((domain) => ({
				name: domain.name,
				colour: domain.colour,
				description: domain.description,
				includeData: domain.includeData,
				objects: domain.objects.map((object) => ({
					schema: object.schema,
					kind: object.kind,
					name: object.name,
				})),
			})),
		},
		// Deliberately short, and deliberately free of the words a test
		// looks for: nothing here may read like a timestamped banner, and
		// `carries no host, port, user or password` is a plain substring
		// check over the whole file.
		[
			"Written by DataGripe — this datasource's domain tagging.",
			"Edited through the domain manager; committed so a teammate who",
			"pulls the repository gets the same tagging.",
		],
	);
}
