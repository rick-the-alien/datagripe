import { formatSql } from "@datagripe/sql-tools";
import * as monaco from "monaco-editor";
import {
	connectionIdForDocument,
	dialectForConnection,
} from "../../stores/documentConnection";
import { sqlCompletionProvider } from "../completion/provider";
import { documentIdFromModelUri } from "../modelRegistry";
import { sqlBlockAt } from "./blocks";

/**
 * The SQL editor's features, inside a `sql` fence and nowhere else
 * (docs/spec/markdown-documents.md "Editing").
 *
 * Monaco does not do embedded languages, so this happens at the provider
 * seam rather than the grammar seam: find the fence containing the
 * position, return nothing when there is not one, and otherwise delegate
 * with the offsets translated into fence-local coordinates.
 *
 * The "return nothing" half is the important half. Completion that fell
 * through to the SQL provider would offer table names in the middle of a
 * paragraph, and Ctrl+Alt+L would run the SQL formatter over prose.
 */

/** The fence containing a position, in model coordinates. */
function fenceAt(
	model: monaco.editor.ITextModel,
	position: monaco.Position,
): { text: string; start: number; end: number } | null {
	const source = model.getValue();
	const block = sqlBlockAt(source, model.getOffsetAt(position));
	return block === null
		? null
		: { text: block.text, start: block.start, end: block.end };
}

/** The model range a fence's content occupies. */
function fenceRange(
	model: monaco.editor.ITextModel,
	block: { start: number; end: number },
): monaco.Range {
	const from = model.getPositionAt(block.start);
	const to = model.getPositionAt(block.end);
	return new monaco.Range(
		from.lineNumber,
		from.column,
		to.lineNumber,
		to.column,
	);
}

function optionsFor(
	model: monaco.editor.ITextModel,
	options: monaco.languages.FormattingOptions,
) {
	return {
		indent: options.insertSpaces ? " ".repeat(options.tabSize) : "\t",
		dialect: dialectForConnection(
			connectionIdForDocument(documentIdFromModelUri(model.uri)),
		),
	};
}

export function registerMarkdownSqlSupport(): monaco.IDisposable {
	const completion = monaco.languages.registerCompletionItemProvider(
		"markdown",
		sqlCompletionProvider(undefined, (model, position) => {
			const block = fenceAt(model, position);
			return block === null
				? null
				: {
						text: block.text,
						// Fence-local: the SQL side must not see the prose above it
						// as part of the statement the caret is in.
						offset: model.getOffsetAt(position) - block.start,
					};
		}),
	);

	/**
	 * Ctrl+Alt+L with the caret in a fence formats that fence. With the
	 * caret in prose it does nothing — running the SQL formatter over a
	 * paragraph is worse than not being bound at all.
	 */
	const formatting = monaco.languages.registerDocumentFormattingEditProvider(
		"markdown",
		{
			displayName: "DataGripe SQL (in fences)",
			provideDocumentFormattingEdits(model, options) {
				const editors = monaco.editor
					.getEditors()
					.filter((editor) => editor.getModel() === model);
				const position = editors[0]?.getPosition() ?? null;
				if (position === null) {
					return [];
				}
				const source = model.getValue();
				const block = sqlBlockAt(source, model.getOffsetAt(position));
				if (block === null) {
					return [];
				}
				const formatted = formatSql(block.text, optionsFor(model, options));
				// No edit at all when nothing changed: an identity edit would
				// still dirty the document and clear the redo stack.
				return formatted === block.text
					? []
					: [{ range: fenceRange(model, block), text: formatted }];
			},
		},
	);

	const rangeFormatting =
		monaco.languages.registerDocumentRangeFormattingEditProvider("markdown", {
			displayName: "DataGripe SQL (in fences)",
			provideDocumentRangeFormattingEdits(model, selection, options) {
				const source = model.getValue();
				const block = sqlBlockAt(
					source,
					model.getOffsetAt(selection.getStartPosition()),
				);
				// A selection that starts in a fence formats that fence whole:
				// half a statement formatted as if it were a statement of its
				// own comes back indented from nothing.
				if (block === null) {
					return [];
				}
				const formatted = formatSql(block.text, optionsFor(model, options));
				return formatted === block.text
					? []
					: [{ range: fenceRange(model, block), text: formatted }];
			},
		});

	return {
		dispose() {
			completion.dispose();
			formatting.dispose();
			rangeFormatting.dispose();
		},
	};
}
