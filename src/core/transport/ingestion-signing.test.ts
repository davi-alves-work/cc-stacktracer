import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signIngestionRequest } from './ingestion-signing.js';

describe('signIngestionRequest', () => {
  it('x-signature = v1= + HMAC-SHA256(apiKey, canónica v1) com corpo UTF-8 no sha256', () => {
    const apiKey = 'ingest-api-key';
    const body = '{"events":[]}';
    const headers = signIngestionRequest({
      apiKey,
      method: 'POST',
      path: '/v1/events',
      serializedBody: body,
    });

    const ts = headers['x-timestamp'];
    const nonce = headers['x-nonce'];
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(nonce).toMatch(/^[0-9a-f-]{36}$/i);
    expect(headers['x-signature']).toMatch(/^v1=[a-f0-9]{64}$/);

    const bodySha = createHash('sha256').update(body, 'utf8').digest('hex');
    const canonical = ['v1', 'POST', '/v1/events', ts, nonce, `sha256:${bodySha}`].join('\n');
    const expected = `v1=${createHmac('sha256', apiKey).update(canonical, 'utf8').digest('hex')}`;
    expect(headers['x-signature']).toBe(expected);
  });

  it('usa path /v1/spans no canónico', () => {
    const body = '{"spans":[]}';
    const headers = signIngestionRequest({
      apiKey: 'k',
      method: 'POST',
      path: '/v1/spans',
      serializedBody: body,
    });
    const bodySha = createHash('sha256').update(body, 'utf8').digest('hex');
    const canonical = ['v1', 'POST', '/v1/spans', headers['x-timestamp'], headers['x-nonce'], `sha256:${bodySha}`].join(
      '\n',
    );
    expect(headers['x-signature']).toBe(`v1=${createHmac('sha256', 'k').update(canonical, 'utf8').digest('hex')}`);
  });
});
