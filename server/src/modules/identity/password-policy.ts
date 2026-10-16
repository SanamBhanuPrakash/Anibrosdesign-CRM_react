import { MAX_PASSWORD_LENGTH } from './passwords';

/**
 * Password policy (NIST 800-63B oriented): length over composition rules, block known-bad passwords,
 * block passwords derived from the user's own identity. No periodic expiry.
 * Optional later: k-anonymity breached-password check (HIBP) behind a feature flag.
 */
const COMMON = new Set(
  (
    'password,password1,password12,password123,password1234,passw0rd,p@ssw0rd,qwerty,qwerty123,qwertyuiop,12345678,123456789,' +
    '1234567890,0123456789,11111111,00000000,iloveyou,letmein,welcome,welcome1,welcome123,admin,admin123,administrator,abc12345,' +
    'abcd1234,monkey,dragon,football,baseball,sunshine,princess,master,shadow,superman,trustno1,changeme,changeme123,default,' +
    'login,access,whatever,hello123,freedom,computer,internet,000000,654321,66666666,987654321,1q2w3e4r,1qaz2wsx,zaq12wsx,' +
    'qazwsxedc,asdfghjkl,asdf1234,zxcvbnm,zxcvbnm123,test1234,testtest,secret,secret123,anibros,anibros123,crm12345,realestate'
  ).split(',')
);

export const MIN_PASSWORD_LENGTH = 10;

export function passwordProblems(password: string, identity: { email?: string; name?: string } = {}): string[] {
  const problems: string[] = [];
  if (password.length < MIN_PASSWORD_LENGTH) problems.push(`Use at least ${MIN_PASSWORD_LENGTH} characters`);
  if (password.length > MAX_PASSWORD_LENGTH) problems.push(`Use at most ${MAX_PASSWORD_LENGTH} characters`);
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) problems.push('This password is too common');

  const local = identity.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) problems.push('Do not include your email address');
  for (const part of (identity.name ?? '').toLowerCase().split(/\s+/)) {
    if (part.length >= 4 && lower.includes(part)) {
      problems.push('Do not include your name');
      break;
    }
  }
  if (/^(.)\1+$/.test(password)) problems.push('Do not repeat a single character');
  // Weak structure (sequences / only one character class) unless it is a long passphrase.
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (password.length < 16 && classes < 2) problems.push('Mix letters with numbers or symbols, or use a longer passphrase');
  return problems;
}
