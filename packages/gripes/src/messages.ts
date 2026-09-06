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
 * **This list is empty and must be populated before any catalogue
 * ships.** It is the one thing in the gripes engine that cannot be
 * delegated to a machine: the brand spec's rule is "nothing touching
 * race, gender, sexuality, disability or religion at any level", and
 * deciding the terms is a deliberate review step, not a guess by
 * whoever last touched this file.
 *
 * `assertNoBarredTerms` is tested against an injected list, so the
 * mechanism is proven and only the contents are outstanding. An empty
 * list here means the check currently passes trivially — that is a
 * known gap, tracked in the roadmap, and not a claim of safety.
 */
export const BARRED_TERMS: string[] = [];
