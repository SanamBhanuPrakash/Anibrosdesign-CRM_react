import { describe, it, expect } from 'vitest';
import { BlockedTargetError, assertPublicUrl, checkUrlShape, postJson } from '../modules/outbound/safe-http';

/**
 * With default settings (private addresses NOT allowed, as in production) a customer-typed webhook address can never be used to reach
 * the CRM's own network. No database needed.
 */
describe('webhook addresses are public or nothing', () => {
  const blocked = [
    'http://localhost/hook',
    'https://localhost:8443/hook',
    'https://app.localhost/hook',
    'https://printer.local/hook',
    'https://db.internal/hook',
    'https://127.0.0.1/hook',
    'https://10.0.0.5/hook',
    'https://192.168.0.10/hook',
    'https://172.20.1.1/hook',
    'https://169.254.169.254/latest/meta-data/',
    'https://[::1]/hook',
    'https://[fd00::1]/hook',
    'https://[::ffff:127.0.0.1]/hook',
  ];
  for (const url of blocked) {
    it(`refuses ${url}`, async () => {
      await expect(assertPublicUrl(url)).rejects.toBeInstanceOf(BlockedTargetError);
    });
  }

  it('refuses other schemes, credentials in the address and garbage', () => {
    expect(() => checkUrlShape('ftp://example.com/x')).toThrow(BlockedTargetError);
    expect(() => checkUrlShape('file:///etc/passwd')).toThrow(BlockedTargetError);
    expect(() => checkUrlShape('https://user:pass@example.com/x')).toThrow(/username and password/);
    expect(() => checkUrlShape('javascript:alert(1)')).toThrow(BlockedTargetError);
    expect(() => checkUrlShape('not a url')).toThrow(/valid web address/);
  });

  it('accepts an ordinary public https address (shape only)', () => {
    expect(checkUrlShape('https://hooks.example.com/crm?x=1').hostname).toBe('hooks.example.com');
    expect(checkUrlShape('https://8.8.8.8/hook').hostname).toBe('8.8.8.8');
  });

  it('sending itself also refuses a private target, whatever the stored address says', async () => {
    await expect(postJson('https://127.0.0.1:9/hook', '{}', {}, { timeoutMs: 500 })).rejects.toBeInstanceOf(BlockedTargetError);
    await expect(postJson('https://169.254.169.254/', '{}', {}, { timeoutMs: 500 })).rejects.toBeInstanceOf(BlockedTargetError);
  });
});
