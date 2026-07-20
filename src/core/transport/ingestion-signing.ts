import { createHash, createHmac, randomUUID } from 'node:crypto';

export type SignIngestionRequestInput = {
  apiKey: string;
  method: 'POST';
  /** Path do pedido HTTP (ex.: `new URL(url).pathname`), igual ao usado pelo servidor na canónica. */
  path: string;
  serializedBody: string;
};

function sha256HexUtf8Body(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

export function signIngestionRequest(input: SignIngestionRequestInput): Record<string, string> {
  const timestamp = new Date().toISOString();
  const nonce = randomUUID();
  const bodyHash = sha256HexUtf8Body(input.serializedBody);
  const canonical = ['v1', input.method, input.path, timestamp, nonce, `sha256:${bodyHash}`].join('\n');
  const signature = createHmac('sha256', input.apiKey).update(canonical, 'utf8').digest('hex');

  return {
    'x-timestamp': timestamp,
    'x-nonce': nonce,
    'x-signature': `v1=${signature}`,
  };
}
