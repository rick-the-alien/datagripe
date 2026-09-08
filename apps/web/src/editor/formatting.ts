import { formatSql } from "@datagripe/sql-tools";
import * as monaco from "monaco-editor";
import {
	connectionIdForDocument,
	dialectForConnection,
} from "../stores/documentConnection";
import { documentIdFromModelUri } from "./modelRegistry";

/**
 * Reformat the current document — Ctrl+Alt+L, the IntelliJ/DataGrip
 * binding (docs/spec/editor-workspace.md "Formatting").
 *
 * Wired as Monaco formatting providers rather than as a command of our
 * own, so one registration covers everything: the SQL editor, the table
 * view's JSON value editor (whose formatter is the JSON language
 * service), the editor context menu, and Monaco's own Shift+Alt+F. With
 * a selection the binding formats the selection, without one the whole
 * document — what Ctrl+Alt+L does in IntelliJ.
 *
 * The keybinding is registered globally with `addKeybindingRules`, not
 * per editor with `editor.addCommand`: command registrations are global
 * anyway, so per-editor bindings collide across split views and the last
 * editor created shadows the rest (docs/spec/editor-workspace.md).
 */

/** Indentation and dialect for a model, from Monaco's own settings. */
function optionsFor(
	model: monaco.editor.ITextModel,
	options: monaco.languages.FormattingOptions,
) {
	const documentId = documentIdFromModelUri(model.uri);
	return {
		indent: options.insertSpaces ? " ".repeat(options.tabSize) : "\t",
		// The dialect is resolved from the document's connection for the
		// same reason completion and the gripe runner resolve it: MySQL
		// backticks and Postgres dollar-quotes tokenize differently, and a
		// formatter that guessed would rewrite a literal.
		dialect: dialectForConnection(connectionIdForDocument(documentId)),
	};
}

export function registerSqlFormatting(): monaco.IDisposable {
	const whole = monaco.languages.registerDocumentFormattingEditProvider("sql", {
		displayName: "DataGripe SQL",
		provideDocumentFormattingEdits(model, options) {
			const text = model.getValue();
			const formatted = formatSql(text, optionsFor(model, options));
			// No edit at all when nothing changed: an identity edit would
			// still dirty the document and clear the redo stack.
			return formatted === text
				? []
				: [{ range: model.getFullModelRange(), text: formatted }];
		},
	});

	const range = monaco.languages.registerDocumentRangeFormattingEditProvider(
		"sql",
		{
			displayName: "DataGripe SQL",
			provideDocumentRangeFormattingEdits(model, selection, options) {
				// Widened to whole lines: half a statement formatted as if it
				// were a statement of its own comes back indented from
				// nothing, and the leading text of the line is lost.
				const lines = new monaco.Range(
					selection.startLineNumber,
					1,
					selection.endLineNumber,
					model.getLineMaxColumn(selection.endLineNumber),
				);
				const text = model.getValueInRange(lines);
				const formatted = formatSql(text, optionsFor(model, options));
				return formatted === text ? [] : [{ range: lines, text: formatted }];
			},
		},
	);

	const keybindings = monaco.editor.addKeybindingRules([
		{
			keybinding:
				monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyL,
			command: "editor.action.formatDocument",
			when: "!editorHasSelection",
		},
		{
			keybinding:
				monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyL,
			command: "editor.action.formatSelection",
			when: "editorHasSelection",
		},
	]);

	return {
		dispose: () => {
			whole.dispose();
			range.dispose();
			keybindings.dispose();
		},
	};
}
