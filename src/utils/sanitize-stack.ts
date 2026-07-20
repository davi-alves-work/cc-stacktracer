/**
 * Redacts absolute filesystem paths from stack traces before ingest.
 * Keeps frame structure; removes host-specific paths (Windows / Unix / file://).
 */
export function sanitizeStackTrace(stack: string): string {
  return stack
    .split('\n')
    .map((line) =>
      line
        .replace(/\(file:\/\/\/[A-Za-z]:[^)]+\)/gi, '(...)')
        .replace(/\([A-Za-z]:\\[^)]+\)/g, '(...)')
        .replace(/\(\/[^)]+\)/g, (match) => {
          if (match.includes('node_modules')) {
            return match;
          }
          if (/^\(\/(?:Users|home|var|tmp|opt)\//.test(match)) {
            return '(...)';
          }
          return match;
        }),
    )
    .join('\n');
}
