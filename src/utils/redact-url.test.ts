import { describe, expect, it } from 'vitest';
import { redactUrl } from './redact-url.js';

describe('redactUrl', () => {
  it('redacts default sensitive query keys while preserving safe params', () => {
    expect(redactUrl('/callback?code=secret&state=ok')).toBe('/callback?code=%5BREDACTED%5D&state=ok');
  });

  it('redacts token query values', () => {
    expect(redactUrl('/invite?token=secret')).toBe('/invite?token=%5BREDACTED%5D');
  });

  it('redacts repeated sensitive keys', () => {
    expect(redactUrl('/x?token=a&token=b&ok=1')).toBe('/x?token=%5BREDACTED%5D&token=%5BREDACTED%5D&ok=1');
  });

  it('handles encoded keys and values through URL parsing', () => {
    expect(redactUrl('/x?access%5Ftoken=s%20e%20c%20r%20e%20t&next=%2Fhome')).toBe(
      '/x?access_token=%5BREDACTED%5D&next=%2Fhome',
    );
  });

  it('keeps absolute URL path and query without origin', () => {
    expect(redactUrl('https://example.com/path?token=secret&debug=1')).toBe('/path?token=%5BREDACTED%5D&debug=1');
  });

  it('redacts extra sensitive query keys case-insensitively', () => {
    expect(redactUrl('/x?CustomSecret=hide&visible=yes', { extraSensitiveQueryKeys: ['customsecret'] })).toBe(
      '/x?CustomSecret=%5BREDACTED%5D&visible=yes',
    );
  });
});
