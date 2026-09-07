import type { MessageCatalogue } from "./render";

/**
 * The wording (docs/spec/gripes.md, brand-system.md "Writing gripes").
 *
 * Four fixed strings per rule. The technical content never changes
 * between levels — only the register. These are copy, reviewed like
 * copy, and `assertions.ts` enforces the mechanical half of the rules
 * (length, profanity at `notice`, placeholders that resolve).
 *
 * Every string here is quoted verbatim from brand-system.md "The same
 * finding at each level". They are not paraphrased, improved, or
 * extended, because the calibration is the specification.
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
