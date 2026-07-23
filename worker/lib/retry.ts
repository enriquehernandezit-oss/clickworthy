// Small retry wrapper for transient external-API failures (Claid, Gmail).
// Retries with exponential backoff; re-throws the last error if all attempts
// fail so the caller's existing error handling still runs.

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseDelayMs?: number; label?: string } = {}
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        console.warn(
          `[retry] ${opts.label ?? "call"} failed (attempt ${attempt}/${attempts}), ` +
            `retrying in ${delay}ms:`,
          err instanceof Error ? err.message : err
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}
