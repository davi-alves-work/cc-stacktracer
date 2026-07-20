/** UUID v4 (loose) pattern for route segments that should be patterns instead. */
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Returns true if a path segment looks like a raw id (numeric only or UUID) — bad for `/users/:id` rollups.
 */
export function segmentLooksLikeRawId(segment: string): boolean {
  if (segment === '' || segment === '.' || segment === '..') {
    return false;
  }
  if (/^\d+$/.test(segment)) {
    return true;
  }
  if (UUID_SEGMENT.test(segment)) {
    return true;
  }
  return false;
}

/**
 * True when `route` still contains dynamic raw segments (e.g. `/users/123` instead of `/users/:id`).
 */
export function routeHasRawDynamicSegments(route: string): boolean {
  const trimmed = route.trim();
  if (trimmed === '') {
    return false;
  }
  const parts = trimmed.split('/').filter(Boolean);
  for (const p of parts) {
    if (segmentLooksLikeRawId(p)) {
      return true;
    }
  }
  return false;
}

function maskPathSegment(segment: string): string {
  if (segment === '') {
    return segment;
  }
  if (segmentLooksLikeRawId(segment)) {
    return ':id';
  }
  if (/^[0-9a-f]{32}$/i.test(segment)) {
    return ':id';
  }
  return segment;
}

function maskPathnameSegments(pathname: string): string {
  if (pathname === '' || pathname === '/') {
    return pathname;
  }
  const parts = pathname.split('/');
  return parts.map(maskPathSegment).join('/');
}

/**
 * Replaces raw numeric/UUID path segments with `:id` for rollup-safe routes.
 * Supports optional `METHOD /path` prefix (e.g. `GET /api/users/1` → `GET /api/users/:id`).
 */
export function maskDynamicRouteSegments(route: string): string {
  const trimmed = route.trim();
  if (trimmed === '') {
    return '/';
  }
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx > 0) {
    const head = trimmed.slice(0, spaceIdx);
    const tail = trimmed.slice(spaceIdx + 1).trim();
    if (/^[A-Za-z]+$/.test(head) && tail.startsWith('/')) {
      return `${head.toUpperCase()} ${maskPathnameSegments(tail)}`;
    }
  }
  const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return maskPathnameSegments(path);
}
