export class OperationTimeoutError extends Error {
	readonly code = "ETIMEDOUT";
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Operation timed out after ${timeoutMs} ms`);
		this.name = "OperationTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

// The underlying ssh2 and dns calls cannot always be cancelled, so the timer
// only stops the page from waiting on them.
export const withTimeout = <T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T> =>
	new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new OperationTimeoutError(timeoutMs));
		}, timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
