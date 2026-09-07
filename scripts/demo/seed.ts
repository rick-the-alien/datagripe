/**
 * Seed the demo project (docs/spec/gripes.md).
 *
 * Creates or refreshes a workspace called "Demo" whose default
 * connection is the predefined read-only `local-demo`, and loads every
 * file in `scripts/demo/queries/` into it as a document.
 *
 * Read-only on purpose: the demo files contain unqualified deletes and
 * updates, because those are the findings most worth seeing. Gripes are
 * static analysis, so nothing has to run for them to appear, and the
 * connection makes sure nothing can.
 *
 * Idempotent — matches documents by title, so re-running updates content
 * in place rather than piling up duplicates.
 *
 *   bun run scripts/demo/seed.ts [owner-email]
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SQL } from "bun";

const OWNER_EMAIL = process.argv[2] ?? "dev@datagripe.local";
const WORKSPACE_NAME = "Demo";
const CONNECTION_REF = "predefined:local-demo";

const databaseUrl = process.env.APP_DATABASE_URL;
if (databaseUrl === undefined) {
	console.error("APP_DATABASE_URL is not set (try: set -a; . ./.env; set +a)");
	process.exit(1);
}

const sql = new SQL(databaseUrl);
const queriesDir = join(dirname(Bun.main), "queries");

const [owner] = await sql`
	select id from users where email = ${OWNER_EMAIL}
`;
if (owner === undefined) {
	console.error(`no user with email ${OWNER_EMAIL}`);
	process.exit(1);
}

const [existing] = await sql`
	select id from workspaces
	where name = ${WORKSPACE_NAME} and owner_id = ${owner.id}
`;
const workspaceId =
	existing?.id ??
	(
		await sql`
			insert into workspaces (owner_id, name, default_connection_ref)
			values (${owner.id}, ${WORKSPACE_NAME}, ${CONNECTION_REF})
			returning id
		`
	)[0].id;

// The ref may have changed since the workspace was made, and membership
// is what makes the project appear in the switcher at all.
await sql`
	update workspaces set default_connection_ref = ${CONNECTION_REF}
	where id = ${workspaceId}
`;
await sql`
	insert into workspace_members (workspace_id, user_id, role)
	values (${workspaceId}, ${owner.id}, 'owner')
	on conflict do nothing
`;

const files = (await readdir(queriesDir))
	.filter((name) => name.endsWith(".sql"))
	.sort();
for (const name of files) {
	const content = await readFile(join(queriesDir, name), "utf8");
	const [document] = await sql`
		select id, content from documents
		where workspace_id = ${workspaceId} and title = ${name}
	`;
	if (document === undefined) {
		await sql`
			insert into documents (workspace_id, title, content, revision)
			values (${workspaceId}, ${name}, ${content}, 0)
		`;
		console.log(`  created ${name}`);
		continue;
	}
	if (document.content === content) {
		console.log(`unchanged ${name}`);
		continue;
	}
	// Bumping the revision is what tells connected clients to reload.
	await sql`
		update documents
		set content = ${content}, revision = revision + 1,
		    archived_at = null, updated_at = now()
		where id = ${document.id}
	`;
	console.log(`  updated ${name}`);
}

// A file removed from the repo should leave the project, but archiving
// is reversible and deleting is not.
const active = await sql`
	select id, title from documents
	where workspace_id = ${workspaceId} and archived_at is null
`;
const stale = active.filter(
	(document: { title: string }) => !files.includes(document.title),
);
for (const document of stale) {
	await sql`update documents set archived_at = now() where id = ${document.id}`;
	console.log(` archived ${document.title}`);
}

console.log(`\nDemo project ${workspaceId} -> ${CONNECTION_REF}`);
await sql.end();
