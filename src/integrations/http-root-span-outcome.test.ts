import { describe, expect, it } from 'vitest';
import { httpRootSpanOutcome } from './http-root-span-outcome.js';

describe('httpRootSpanOutcome', () => {
  it('abort is a transport fact: no error status, no status code, flag set', () => {
    expect(httpRootSpanOutcome(true, 200)).toEqual({
      status: 'ok',
      http_status_code: null,
      http_aborted: true,
      error_type: null,
      error_message: 'Client closed request before the response finished',
    });
  });

  it('normal 2xx response', () => {
    expect(httpRootSpanOutcome(false, 200)).toEqual({
      status: 'ok',
      http_status_code: 200,
      http_aborted: false,
      error_type: null,
      error_message: null,
    });
  });

  it('5xx is an operation failure', () => {
    expect(httpRootSpanOutcome(false, 500)).toEqual({
      status: 'error',
      http_status_code: 500,
      http_aborted: false,
      error_type: null,
      error_message: null,
    });
  });

  it('abort after a 5xx was already determined keeps both facts', () => {
    expect(httpRootSpanOutcome(true, 500)).toEqual({
      status: 'error',
      http_status_code: null,
      http_aborted: true,
      error_type: null,
      error_message: 'Client closed request before the response finished',
    });
  });
});
