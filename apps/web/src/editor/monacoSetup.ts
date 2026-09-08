import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import { registerSqlCompletion } from "./completion/provider";

/**
 * Monaco bundled locally (no CDN loader). SQL needs no worker of its own
 * (its grammar and our completion provider run on the main thread), but
 * JSON does: the table view's value editor
 * (docs/spec/table-view.md "The value editor") gets its squiggles from
 * the JSON language service, and without this worker a malformed `jsonb`
 * value would look fine right up until the database refused it.
 */
self.MonacoEnvironment = {
	getWorker: (_workerId, label) =>
		label === "json" ? new jsonWorker() : new editorWorker(),
};

monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
	validate: true,
	// A database JSON value is data, not a config file: comments and
	// trailing commas are errors, not tolerated extensions.
	allowComments: false,
	trailingCommas: "error",
	schemaValidation: "error",
	enableSchemaRequest: false,
});

monaco.editor.defineTheme("datagripe-dark", {
	base: "vs-dark",
	inherit: true,
	// Brand syntax mapping (docs/brand/brand-system.md): keywords magenta,
	// strings soft violet, types/functions cyan, comments faded. Monaco's SQL
	// monarch grammar has no table token; identifiers stay neutral.
	rules: [
		{ token: "keyword.sql", foreground: "FF3EA5" },
		{ token: "string.sql", foreground: "C4A6FF" },
		{ token: "string.double.sql", foreground: "C4A6FF" },
		{ token: "comment.sql", foreground: "3D4759", fontStyle: "italic" },
		{ token: "number.sql", foreground: "5EEAD4" },
		{ token: "operator.sql", foreground: "9AA5B6" },
		{ token: "predefined.sql", foreground: "5EEAD4" },
		// JSON, for the value editor: keys cyan like a type, strings soft
		// violet like SQL strings, literals magenta like keywords.
		{ token: "string.key.json", foreground: "5EEAD4" },
		{ token: "string.value.json", foreground: "C4A6FF" },
		{ token: "number.json", foreground: "5EEAD4" },
		{ token: "keyword.json", foreground: "FF3EA5" },
	],
	colors: {
		"editor.background": "#0B0E14",
		"editor.foreground": "#E2E8F0",
		"editor.lineHighlightBackground": "#161C29",
		"editorLineNumber.foreground": "#3D4759",
		"editorLineNumber.activeForeground": "#9AA5B6",
		"editorCursor.foreground": "#00E599",
		"editor.selectionBackground": "#8B5CF640",
		"editor.inactiveSelectionBackground": "#8B5CF622",
		"editorIndentGuide.background1": "#161C29",
		"editorIndentGuide.activeBackground1": "#212A3A",
		"editorWidget.background": "#161C29",
		"editorWidget.border": "#212A3A",
		"editorSuggestWidget.selectedBackground": "#212A3A",
		"editorHoverWidget.background": "#161C29",
		"editorHoverWidget.border": "#212A3A",
		"editorGutter.background": "#0B0E14",
		"editorError.foreground": "#FF3EA5",
		"editorWarning.foreground": "#A78BFA",
		"scrollbarSlider.background": "#212A3A80",
		"scrollbarSlider.hoverBackground": "#3D475980",
	},
});

registerSqlCompletion();

export { monaco };
