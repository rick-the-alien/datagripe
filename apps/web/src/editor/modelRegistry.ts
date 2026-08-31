/**
 * Monaco model registry — one text model per document, reference-counted
 * by live editor views. The factory is injected so the lifecycle logic is
 * unit-tested without Monaco. See docs/spec/editor-workspace.md.
 */

export type ModelHandle = {
	isDisposed: () => boolean;
	dispose: () => void;
};

export type RegistryDocument = {
	id: string;
	language: "sql";
	currentContent: string;
};

export type ModelFactory<T extends ModelHandle = ModelHandle> = (
	uri: string,
	content: string,
	language: string,
) => T;

export type ModelRegistryDeps<T extends ModelHandle = ModelHandle> = {
	createModel: ModelFactory<T>;
	/**
	 * Called just before the last view's model is disposed — the seam where
	 * the final content is checkpointed to drafts.
	 */
	onLastRelease: (documentId: string) => void;
	/** Defer mechanism for disposal; defaults to a zero-delay timeout. */
	defer?: (task: () => void) => DeferHandle;
	cancelDefer?: (handle: DeferHandle) => void;
};

/** Opaque handle returned by the injected defer function. */
export type DeferHandle = number | TimerHandle;

export type ModelRegistry<T extends ModelHandle = ModelHandle> = {
	acquire: (doc: RegistryDocument) => T;
	release: (documentId: string) => void;
	refCount: (documentId: string) => number;
	has: (documentId: string) => boolean;
};

export function documentModelUri(documentId: string): string {
	return `datagripe://document/${documentId}.sql`;
}

type TimerHandle = ReturnType<typeof setTimeout>;

export function createModelRegistry<T extends ModelHandle = ModelHandle>(
	deps: ModelRegistryDeps<T>,
): ModelRegistry<T> {
	const defer =
		deps.defer ?? ((task: () => void): DeferHandle => setTimeout(task, 0));
	const cancelDefer =
		deps.cancelDefer ??
		((handle: DeferHandle) => {
			clearTimeout(handle as TimerHandle);
		});

	type Entry = {
		model: T;
		refs: number;
		disposeTimer: DeferHandle | undefined;
	};

	const entries = new Map<string, Entry>();

	return {
		acquire(doc) {
			const existing = entries.get(doc.id);
			if (existing !== undefined) {
				existing.refs++;
				if (existing.disposeTimer !== undefined) {
					cancelDefer(existing.disposeTimer);
					existing.disposeTimer = undefined;
				}
				return existing.model;
			}
			const model = deps.createModel(
				documentModelUri(doc.id),
				doc.currentContent,
				doc.language,
			);
			entries.set(doc.id, { model, refs: 1, disposeTimer: undefined });
			return model;
		},

		release(documentId) {
			const entry = entries.get(documentId);
			if (entry === undefined) {
				return;
			}
			entry.refs--;
			if (entry.refs > 0) {
				return;
			}
			// Defer disposal: StrictMode remounts and Dockview panel moves
			// unmount and remount a view; re-acquiring cancels the disposal so
			// the model (and its undo history) survives.
			entry.disposeTimer = defer(() => {
				entries.delete(documentId);
				deps.onLastRelease(documentId);
				if (!entry.model.isDisposed()) {
					entry.model.dispose();
				}
			});
		},

		refCount: (documentId) => entries.get(documentId)?.refs ?? 0,
		has: (documentId) => entries.has(documentId),
	};
}
