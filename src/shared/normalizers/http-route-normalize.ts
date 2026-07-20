/**
 * Strips a leading HTTP verb from `http_route` when it duplicates `http_method`
 * (e.g. framework route labels like `GET /inertia/css/app.css`).
 * Keeps path-only routes unchanged. Used for noise matching and UI consistency.
 */
export function normalizeHttpRouteForSpan(
  method: string | null | undefined,
  route: string | null | undefined,
): string | null {
  if (route === undefined || route === null) {
    return null;
  }
  const r = route.trim();
  if (r === '') {
    return null;
  }

  const m = method?.trim();
  if (m === undefined || m === '') {
    return r;
  }

  const upperMethod = m.toUpperCase();
  const spaceIdx = r.indexOf(' ');
  if (spaceIdx === -1) {
    return r;
  }

  const firstToken = r.slice(0, spaceIdx);
  if (firstToken.toUpperCase() !== upperMethod) {
    return r;
  }

  const rest = r.slice(spaceIdx + 1).trim();
  return rest === '' ? null : rest;
}
