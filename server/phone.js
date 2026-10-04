/**
 * Phone-number helpers for the WhatsApp bridge.
 *
 * A bare 10-digit number is NOT a valid WhatsApp JID — the country code must be
 * included or the message silently fails to deliver. These helpers normalise
 * whatever the admin entered into full international form.
 *
 * Kept in its own module (rather than inside index.js) so it can be unit
 * tested without booting the server or binding a port.
 */

export const DEFAULT_COUNTRY_CODE = '91';

/**
 * Normalise a phone number to full international form: country code plus
 * number, digits only (e.g. `919058767686`).
 *
 * Returns an empty string for input that cannot be made valid, so callers can
 * skip generating a broken wa.me link rather than emit a dead one.
 */
export function normaliseToInternational(raw, countryCode = DEFAULT_COUNTRY_CODE) {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return '';

  if (digits.startsWith('00')) digits = digits.slice(2);   // 0091... -> 91...

  // A number stored as a leading zero plus a 10-digit mobile ("09058767686").
  // Indian mobiles are exactly 10 digits, so drop the stray zero.
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);

  if (digits.length === 10) {
    // Still 10 digits but starting with 0 is not a valid mobile number —
    // the input is malformed and guessing would send the alert elsewhere.
    if (digits.startsWith('0')) return '';
    return digits.startsWith(countryCode) ? digits : countryCode + digits;
  }

  if (digits.startsWith(countryCode) && digits.length > 10) return digits;

  // Anything else (foreign numbers, landlines with area codes) is passed
  // through untouched rather than mangled.
  return digits;
}

/**
 * Human-readable form for the UI and for message bodies: `+91 90587 67686`.
 */
export function formatPhoneDisplay(raw, countryCode = DEFAULT_COUNTRY_CODE) {
  const d = normaliseToInternational(raw, countryCode);
  if (!d) return '';
  if (d.length === 12 && d.startsWith(countryCode)) {
    const rest = d.slice(countryCode.length);
    return `+${countryCode} ${rest.slice(0, 5)} ${rest.slice(5)}`;
  }
  const rest = d.slice(countryCode.length);
  return `+${d.slice(0, countryCode.length)} ${rest.slice(0, 5)} ${rest.slice(5)}`.trim();
}