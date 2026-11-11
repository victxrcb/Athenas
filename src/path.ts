// Windows canonical paths carry a verbatim prefix (two backslashes, a question mark, a backslash) that is noise in the UI.
const VERBATIM_PREFIX = '\\\\?\\';

export const displayPath = (path: string): string =>
  path.startsWith(VERBATIM_PREFIX) ? path.slice(VERBATIM_PREFIX.length) : path;

/** Compares folders ignoring case and the verbatim prefix, so old and new records match. */
export const sameFolder = (a?: string | null, b?: string | null): boolean =>
  !!a && !!b && displayPath(a).toLowerCase() === displayPath(b).toLowerCase();
