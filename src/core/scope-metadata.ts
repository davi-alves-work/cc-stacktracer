import { createHash } from 'node:crypto';

export type StackTraceScopeUser = {
  id: string;
  tenantId?: string;
  /** SHA-256 prefix of normalized email — never raw PII. */
  emailHash?: string;
};

let currentUser: StackTraceScopeUser | undefined;
const tags = new Map<string, string>();

function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex').slice(0, 16);
}

/**
 * Sets end-user context merged into outgoing event `context` (under `user`).
 * Email is never sent raw; an opaque hash is included when provided.
 */
export function setUser(user: { id: string; email?: string; tenantId?: string }): void {
  currentUser = {
    id: user.id,
    ...(user.tenantId !== undefined ? { tenantId: user.tenantId } : {}),
    ...(user.email !== undefined ? { emailHash: hashEmail(user.email) } : {}),
  };
}

export function clearUser(): void {
  currentUser = undefined;
}

export function tag(key: string, value: string): void {
  tags.set(key, value);
}

export function setTags(record: Record<string, string>): void {
  for (const [k, v] of Object.entries(record)) {
    tags.set(k, v);
  }
}

export function clearTags(): void {
  tags.clear();
}

/** For tests / process reset. */
export function resetScopeMetadata(): void {
  currentUser = undefined;
  tags.clear();
}

export function getScopeContextForMerge(): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (currentUser !== undefined) {
    out.user = {
      id: currentUser.id,
      ...(currentUser.tenantId !== undefined ? { tenantId: currentUser.tenantId } : {}),
      ...(currentUser.emailHash !== undefined ? { emailHash: currentUser.emailHash } : {}),
    };
  }
  if (tags.size > 0) {
    out.tags = Object.fromEntries(tags);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
