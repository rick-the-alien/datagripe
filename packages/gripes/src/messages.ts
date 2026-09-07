import type { MessageCatalogue } from "./render";

/**
 * The wording (docs/spec/gripes.md, brand-system.md "Writing gripes").
 *
 * Four fixed strings per rule. The technical content never changes
 * between levels — only the register. These are copy, reviewed like
 * copy, and `assertions.ts` enforces the mechanical half of the rules
 * (length, profanity at `notice`, placeholders that resolve).
 *
 * `join.no-condition` is quoted verbatim from brand-system.md "The same
 * finding at each level" — the calibration is the specification, so it
 * is not paraphrased or improved. The rest are written to that
 * calibration: correct, specific, dry, one beat of personality, and
 * profane only where the finding has earned it. A `style` finding never
 * swears; spending the currency on a redundant index is exactly the
 * failure the brand spec warns about.
 */
export const MESSAGES: MessageCatalogue = {
	"join.no-condition": {
		notice: "This join has no condition. That is a cross product.",
		warning: "This join has no condition. I'll allow it. I won't forget it.",
		fatal:
			"No join condition. You've asked for every row times every row. Absolute state of this.",
		panic:
			"NO JOIN CONDITION. Every row. Times every row. I want you to sit and think about what that number is.",
	},

	"delete.no-where": {
		notice: "This delete has no where clause. It removes every row.",
		warning: "Delete with no where clause. That is the table, not the row.",
		fatal:
			"No where clause on a delete. That is the whole bloody table. Check your backups.",
		panic:
			"DELETE. NO WHERE. EVERY ROW. Say out loud what you think this does before you run it.",
	},

	"update.no-where": {
		notice: "This update has no where clause. It rewrites every row.",
		warning:
			"Update with no where clause. Every row gets this, not just yours.",
		fatal:
			"No where clause. You are about to overwrite that column in every single row.",
		panic:
			"UPDATE WITH NO WHERE. Every row in the table gets this value. Every single one.",
	},

	"column.nullable-inequality": {
		notice: "{column} is nullable, so this excludes the rows where it is null.",
		warning:
			"{column} can be null, and null is not <> anything. Those rows vanish here.",
		fatal:
			"{column} is nullable. null <> anything is unknown, not true, so every null row is silently dropped.",
		panic:
			"{column} IS NULLABLE. Those rows are not missing because you excluded them. They are missing because null compares to nothing.",
	},

	"subquery.not-in": {
		notice:
			"not in with a subquery returns nothing at all if the subquery yields a null.",
		warning:
			"not in against a subquery. One null in there and you get zero rows, silently.",
		fatal:
			"not in with a subquery. One sodding null and this returns nothing, with no error to explain it.",
		panic:
			"NOT IN. A SUBQUERY. One null in that column and your answer is zero rows, quietly, forever. Use not exists.",
	},

	"view.select-star": {
		notice: "select * in a view freezes the column list as it is right now.",
		warning:
			"The star in this view is expanded once, at creation. New columns never appear.",
		fatal:
			"select * in a view definition. That star is spent now; add a column later and the bloody view ignores it.",
		panic:
			"SELECT STAR IN A VIEW. Resolved once and welded shut. Every column you add after today is invisible to it.",
	},

	"index.not-concurrent": {
		notice:
			"create index without concurrently blocks writes until the build finishes.",
		warning:
			"No concurrently. Writes to this table queue up until the index is built.",
		fatal:
			"create index with no concurrently. Every write waits for the whole scan. On anything big that is an outage.",
		panic:
			"NO CONCURRENTLY. This locks out writes for the entire build. Small table here, production on fire there.",
	},

	"table.no-primary-key": {
		notice: "{table} has no primary key, so a row cannot be addressed.",
		warning:
			"No primary key on {table}. Every row is indistinguishable from its twin.",
		fatal:
			"{table} has no primary key. It is a spreadsheet with worse tooling and no undo.",
		panic:
			"NO PRIMARY KEY ON {table}. Explain to me how you delete one row. I'll wait.",
	},

	"index.duplicate": {
		notice: "{index} duplicates the leading columns of {covering}.",
		warning:
			"{index} is already covered by {covering}. It costs writes and buys nothing.",
		fatal:
			"{index} is a prefix of {covering}. You pay for it on every write and read nothing back.",
		panic:
			"{index}. {covering}. The same leading columns. You are paying twice to write once.",
	},

	"routine.definer-no-search-path": {
		notice: "{routine} is security definer with no search_path set.",
		warning:
			"Security definer, no search_path. Anyone who can add a schema owns this.",
		fatal:
			"Security definer with no search_path. That is privilege escalation waiting for a schema.",
		panic:
			"SECURITY DEFINER. NO SEARCH_PATH. It runs as the owner and resolves names as the caller. Fix it today.",
	},

	"routine.volatile-but-readonly": {
		notice:
			"{routine} only reads, but is volatile. stable would let it be cached.",
		warning:
			"{routine} only reads, yet claims volatile. The planner takes you at your word.",
		fatal:
			"{routine} only reads. You left it volatile, so the planner re-runs it for every row.",
		panic:
			"{routine} READS. THAT IS ALL IT DOES. And you told the planner it might do anything.",
	},
};

/**
 * Swearing the brand spec sanctions, and the list `notice` is checked
 * against: "No profanity. Dry and still critical."
 *
 * Deliberately small. Profanity lands because it is rare and
 * proportionate, so this list growing is a signal to stop rather than a
 * licence to continue.
 */
export const SANCTIONED_PROFANITY = [
	"sod",
	"sodding",
	"bloody",
	"hell",
	"damn",
	"damned",
	"crap",
	"arse",
	"bugger",
	"piss",
	"shit",
	"shite",
	"fuck",
	"fucking",
];

/**
 * Terms barred at every level, `panic` included.
 *
 * Grown alongside the wording rather than enumerated up front: a rule
 * arrives with four strings, and anything those strings prove they need
 * fencing off gets added here. `assertNoBarredTerms` then keeps it
 * fenced for every rule that follows.
 *
 * The list being short is not a claim that the wording is safe — the
 * check can only catch what it knows about. What actually holds the line
 * is the brand spec's rule, which is a review standard rather than a
 * string match: "nothing touching race, gender, sexuality, disability or
 * religion at any level", and "it criticises the query, never the person
 * who wrote it". `DISCLAIMER` says as much to the reader.
 */
export const BARRED_TERMS: string[] = [];

/**
 * Shown wherever gripes are read, in the plain product voice rather
 * than the gripe voice — "if the whole interface is sarcastic then
 * nothing is". It sits next to the attitude control because that is
 * where someone chooses the register, and it is the moment the note is
 * worth reading.
 */
export const DISCLAIMER =
	"Gripes criticise the query, never the person who wrote it. fatal and panic swear; choose notice if that is unwelcome.";
