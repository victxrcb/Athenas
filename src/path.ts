// Windows canonical paths carry a verbatim prefix (two backslashes, a question mark, a backslash) that is noise in the UI.
const VERBATIM_PREFIX = '\\\\?\\';

export const displayPath = (path: string): string =>
  path.startsWith(VERBATIM_PREFIX) ? path.slice(VERBATIM_PREFIX.length) : path;
