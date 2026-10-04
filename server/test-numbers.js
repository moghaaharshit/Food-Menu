/**
 * Unit tests for phone-number normalisation and display formatting.
 *
 * A bare 10-digit number is NOT a valid WhatsApp JID — the country code must be
 * present or messages silently fail to deliver. These cases pin the behaviour
 * down so the earlier bug (owner JID `9058767686@…` with no country code)
 * cannot come back.
 *
 *   npm run test:numbers
 */
import { normaliseToInternational, formatPhoneDisplay } from './phone.js';

let failures = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) { console.log(`        got  "${got}"\n        want "${want}"`); failures++; }
};

console.log('\n-- normaliseToInternational --');

check('bare 10-digit Indian number',
  normaliseToInternational('9058767686'), '919058767686');

check('already international',
  normaliseToInternational('919058767686'), '919058767686');

check('formatted with + and spaces',
  normaliseToInternational('+91 90587 67686'), '919058767686');

check('00 international prefix stripped',
  normaliseToInternational('0091 90587 67686'), '919058767686');

check('all punctuation stripped',
  normaliseToInternational('+91-90587-67686'), '919058767686');

check('leading zero on a stored 11-digit number is dropped',
  normaliseToInternational('09058767686'), '919058767686');

check('malformed 10-digit starting with 0 is rejected, not guessed',
  normaliseToInternational('0987654321'), '');

check('empty input stays empty',
  normaliseToInternational(''), '');

check('undefined input stays empty',
  normaliseToInternational(undefined), '');

check('foreign long number passes through untouched',
  normaliseToInternational('14155552671'), '14155552671');

console.log('\n-- formatPhoneDisplay --');

check('international displays grouped',
  formatPhoneDisplay('919058767686'), '+91 90587 67686');

check('bare number displays with country code',
  formatPhoneDisplay('9058767686'), '+91 90587 67686');

check('leading-zero form displays correctly',
  formatPhoneDisplay('09058767686'), '+91 90587 67686');

check('malformed displays as empty',
  formatPhoneDisplay('0987654321'), '');

check('empty displays as empty',
  formatPhoneDisplay(''), '');

console.log(`\n${failures === 0 ? 'ALL NUMBER CHECKS PASSED' : failures + ' CHECK(S) FAILED'}`);
process.exitCode = failures === 0 ? 0 : 1;