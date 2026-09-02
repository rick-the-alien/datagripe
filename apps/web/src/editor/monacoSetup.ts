import * as monaco from "monaco-editor";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { registerSqlCompletion } from "./completion/provider";

/**
 * Monaco bundled locally (no CDN loader). SQL is the only language we
 * register workers for; the base editor worker covers everything else.
 */
self.MonacoEnvironment = {
	getWorker: () => new editorWorker(),
};

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
