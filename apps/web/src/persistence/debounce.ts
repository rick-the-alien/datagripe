/**
 * Keyed trailing-edge debouncer. Each key has its own pending task so a
 * busy document never starves another's checkpoint. `flush` forces the
 * pending task for one key (or every key) to run immediately; used when a
 * view unmounts and on `beforeunload`.
 */
export type Debouncer = {
	schedule: (key: string, task: () => void, delayMs: number) => void;
	flush: (key?: string) => void;
	cancel: (key: string) => void;
	pending: (key: string) => boolean;
};

/** Handle produced by the injected timer functions; never leaves this module. */
type TimerHandle = ReturnType<typeof setTimeout>;

export function createDebouncer(
	setTimeoutFn: typeof setTimeout = setTimeout,
	clearTimeoutFn: typeof clearTimeout = clearTimeout,
): Debouncer {
	const timers = new Map<string, TimerHandle>();
	const tasks = new Map<string, () => void>();

	const cancel = (key: string): void => {
		const timer = timers.get(key);
		if (timer !== undefined) {
			clearTimeoutFn(timer);
			timers.delete(key);
		}
		tasks.delete(key);
	};

	const run = (key: string): void => {
		const task = tasks.get(key);
		cancel(key);
		task?.();
	};

	return {
		schedule(key, task, delayMs) {
			cancel(key);
			tasks.set(key, task);
			timers.set(
				key,
				setTimeoutFn(() => run(key), delayMs),
			);
		},
		flush(key) {
			if (key !== undefined) {
				run(key);
				return;
			}
			for (const pending of [...tasks.keys()]) {
				run(pending);
			}
		},
		cancel,
		pending: (key) => tasks.has(key),
	};
}
