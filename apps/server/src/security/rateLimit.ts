/**
 * In-memory token-bucket rate limiting (docs/spec/auth-and-hardening.md).
 * Keyed by scope+subject; buckets refill continuously. Stale buckets are
 * reaped lazily on access and periodically by `sweep`.
 */

export interface BucketSpec {
	capacity: number;
	refillPerMinute: number;
}

export interface RateLimiter {
	/** Take one token; false when the bucket is exhausted. */
	take: (scope: string, subject: string) => boolean;
	sweep: () => void;
	stop: () => void;
}

interface Bucket {
	tokens: number;
	updatedAt: number;
}

const SWEEP_INTERVAL_MS = 10 * 60_000;
const STALE_AFTER_MS = 60 * 60_000;

export function createRateLimiter(
	specs: Record<string, BucketSpec>,
	now: () => number = Date.now,
): RateLimiter {
	const buckets = new Map<string, Bucket>();
	const sweepTimer = setInterval(() => limiter.sweep(), SWEEP_INTERVAL_MS);
	sweepTimer.unref();

	const limiter: RateLimiter = {
		take(scope, subject) {
			const spec = specs[scope];
			if (spec === undefined) {
				return true;
			}
			const key = `${scope}:${subject}`;
			const at = now();
			let bucket = buckets.get(key);
			if (bucket === undefined) {
				bucket = { tokens: spec.capacity, updatedAt: at };
				buckets.set(key, bucket);
			}
			const elapsedMinutes = (at - bucket.updatedAt) / 60_000;
			bucket.tokens = Math.min(
				spec.capacity,
				bucket.tokens + elapsedMinutes * spec.refillPerMinute,
			);
			bucket.updatedAt = at;
			if (bucket.tokens < 1) {
				return false;
			}
			bucket.tokens -= 1;
			return true;
		},

		sweep() {
			const at = now();
			for (const [key, bucket] of buckets) {
				if (at - bucket.updatedAt > STALE_AFTER_MS) {
					buckets.delete(key);
				}
			}
		},

		stop() {
			clearInterval(sweepTimer);
		},
	};
	return limiter;
}
