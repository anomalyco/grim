// Errors are matched by name, not instanceof: Durable Object RPC keeps an error's name, message and own fields but not its prototype.

/** True if `e` is an error named one of `names`. Falls back to the constructor's name for classes that don't set `name` yet (only works in-process). */
export function isErr(e: unknown, ...names: string[]): e is Error & Record<string, unknown> {
  if (!(e instanceof Error)) return false;
  return names.includes(e.name) || (e.name === "Error" && names.includes(e.constructor?.name));
}

/** The HTTP status a domain error maps to, or undefined for anything else (a 500). */
export function errStatus(e: unknown): number | undefined {
  if (isErr(e, "HttpError", "OpError")) return typeof e.status === "number" ? e.status : undefined;
  if (isErr(e, "RepoBusyError")) return 409;
  if (isErr(e, "FileTooLargeError", "StoreFullError")) return 413;
  if (isErr(e, "StoreUnavailableError")) return 503;
  if (isErr(e, "NotFoundError")) return 404;
  return undefined;
}
