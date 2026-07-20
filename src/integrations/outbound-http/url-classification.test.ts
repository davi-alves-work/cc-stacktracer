import { describe, expect, it } from 'vitest';
import { classifyOutboundUrl, sanitizedTarget } from './url-classification.js';

describe('classifyOutboundUrl', () => {
  it('classifies a third-party host as external_api', () => {
    expect(classifyOutboundUrl(new URL('https://api.stripe.com/v1/charges'), {})).toEqual({ kind: 'external_api' });
  });

  it('classifies a configured host as internal_service', () => {
    const c = classifyOutboundUrl(new URL('https://billing.internal.local/charge'), {
      internalServiceMap: { 'billing.internal.local': 'billing-service' },
    });
    expect(c).toEqual({ kind: 'internal_service', serviceName: 'billing-service' });
  });

  it('uses serviceNameResolver when no map entry matches', () => {
    const c = classifyOutboundUrl(new URL('https://orders.svc/health'), {
      serviceNameResolver: (u) => (u.hostname.endsWith('.svc') ? 'orders-service' : undefined),
    });
    expect(c).toEqual({ kind: 'internal_service', serviceName: 'orders-service' });
  });

  it('ignores URLs matching ignoreUrls', () => {
    expect(classifyOutboundUrl(new URL('https://api.example.com/health'), { ignoreUrls: ['/health'] })).toEqual({
      kind: 'ignored',
    });
  });

  it('ignores URLs not matching a non-empty allowUrls list', () => {
    expect(classifyOutboundUrl(new URL('https://api.example.com/x'), { allowUrls: [/internal\.local/] })).toEqual({
      kind: 'ignored',
    });
  });

  it('sanitizedTarget drops the query string', () => {
    expect(sanitizedTarget(new URL('https://api.example.com/users/42?token=secret'))).toBe('api.example.com/users/42');
  });
});
