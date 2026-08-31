import { describe, expect, test } from "bun:test";
import {
	createModelRegistry,
	type DeferHandle,
	documentModelUri,
	type ModelHandle,
	type RegistryDocument,
} from "./modelRegistry";

function fakeModel(): ModelHandle & { disposed: boolean } {
	const state = { disposed: false };
	return {
		get disposed() {
			return state.disposed;
		},
		isDisposed: () => state.disposed,
		dispose: () => {
			state.disposed = true;
		},
	};
}

/** Manual defer driver — disposal runs only when flush() is called. */
function createManualDefer() {
	const pending = new Map<number, () => void>();
	let nextId = 1;
	const defer = (task: () => void): DeferHandle => {
		const id = nextId++;
		pending.set(id, task);
		return id;
	};
	const cancelDefer = (handle: DeferHandle) => {
		pending.delete(handle as number);
	};
	const flush = () => {
		for (const [, task] of [...pending]) {
			task();
		}
		pending.clear();
	};
	return { defer, cancelDefer, flush, size: () => pending.size };
}

const DOC: RegistryDocument = {
	id: "11111111-1111-4111-8111-111111111111",
	language: "sql",
	currentContent: "select 1;",
};

function setup(onLastRelease: () => void = () => {}) {
	const driver = createManualDefer();
	const created: Array<{ uri: string; content: string; language: string }> = [];
	const registry = createModelRegistry({
		createModel: (uri, content, language) => {
			created.push({ uri, content, language });
			return fakeModel();
		},
		onLastRelease,
		defer: driver.defer,
		cancelDefer: driver.cancelDefer,
	});
	return { registry, driver, created };
}

describe("model registry", () => {
	test("creates one model with the stable datagripe URI", () => {
		const { registry, created } = setup();
		registry.acquire(DOC);
		expect(created).toEqual([
			{
				uri: documentModelUri(DOC.id),
				content: "select 1;",
				language: "sql",
			},
		]);
		expect(documentModelUri(DOC.id)).toBe(`datagripe://document/${DOC.id}.sql`);
	});

	test("two views share one model; release keeps it alive until zero refs", () => {
		const { registry, driver } = setup();
		const first = registry.acquire(DOC);
		const second = registry.acquire(DOC);
		expect(first).toBe(second);
		expect(registry.refCount(DOC.id)).toBe(2);

		registry.release(DOC.id);
		driver.flush();
		expect(registry.has(DOC.id)).toBe(true);
		expect(first.isDisposed()).toBe(false);

		registry.release(DOC.id);
		driver.flush();
		expect(registry.has(DOC.id)).toBe(false);
		expect(first.isDisposed()).toBe(true);
	});

	test("re-acquire before the deferred disposal keeps the same model", () => {
		const { registry, driver, created } = setup();
		const first = registry.acquire(DOC);
		registry.release(DOC.id);
		const second = registry.acquire(DOC);
		driver.flush();
		expect(second).toBe(first);
		expect(created).toHaveLength(1);
		expect(first.isDisposed()).toBe(false);
		expect(registry.refCount(DOC.id)).toBe(1);
	});

	test("acquire after disposal creates a fresh model", () => {
		const { registry, driver, created } = setup();
		const first = registry.acquire(DOC);
		registry.release(DOC.id);
		driver.flush();
		expect(first.isDisposed()).toBe(true);

		const second = registry.acquire(DOC);
		expect(second).not.toBe(first);
		expect(created).toHaveLength(2);
	});

	test("last release flushes the checkpoint seam before disposal", () => {
		const order: string[] = [];
		const { registry, driver } = setup(() => order.push("checkpoint"));
		const model = registry.acquire(DOC);
		const originalDispose = model.dispose;
		model.dispose = () => {
			order.push("dispose");
			originalDispose();
		};
		registry.release(DOC.id);
		driver.flush();
		expect(order).toEqual(["checkpoint", "dispose"]);
	});

	test("releasing an unknown document is a no-op", () => {
		const { registry, driver } = setup();
		registry.release("00000000-0000-4000-8000-000000000000");
		driver.flush();
		expect(registry.has(DOC.id)).toBe(false);
	});
});
