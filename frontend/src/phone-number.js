import { AsYouType, getCountries, getCountryCallingCode, parsePhoneNumberFromString } from 'libphonenumber-js/min';

const phoneCountries = getCountries();

export function getDefaultPhoneCountry(locale = navigator.language) {
  let region = 'US';
  try {
    region = new Intl.Locale(locale).region || region;
  } catch {
    region = 'US';
  }
  return phoneCountries.includes(region) ? region : 'US';
}

export function getPhoneCountryOptions(locale = navigator.language) {
  const displayNames = new Intl.DisplayNames([locale], { type: 'region' });
  return phoneCountries.map(country => ({
    country,
    name: displayNames.of(country) || country,
    callingCode: getCountryCallingCode(country)
  })).sort((left, right) => left.name.localeCompare(right.name, locale));
}

export function getPhoneCountryCallingCode(country) {
  return getCountryCallingCode(country);
}

export function getPhoneCountryLabel(country, callingCode = getCountryCallingCode(country)) {
  return `${country} +${callingCode}`;
}

export function formatNationalPhoneNumber(value, country) {
  if (!value) return '';
  return new AsYouType(country).input(value);
}

export function formatPhoneInput(value, country) {
  if (!value) return { country, value: '' };
  if (!value.startsWith('+')) return { country, value: formatNationalPhoneNumber(value, country) };
  const formatter = new AsYouType();
  const formatted = formatter.input(value);
  const phone = formatter.getNumber();
  if (phone?.country && phone.isPossible()) {
    return { country: phone.country, value: phone.formatNational() };
  }
  return { country, value: formatted };
}

export function parseAccountPhoneNumber(value, country) {
  const input = value.trim();
  if (!input) return null;
  const phone = parsePhoneNumberFromString(input, input.startsWith('+') ? undefined : country);
  if (!phone?.isValid()) throw new Error('Enter a valid phone number for the selected country.');
  return phone;
}

export function splitAccountPhoneNumber(value, defaultCountry) {
  if (!value) return { country: defaultCountry, nationalNumber: '' };
  const phone = parsePhoneNumberFromString(value, value.startsWith('+') ? undefined : defaultCountry);
  if (!phone?.isValid()) return { country: defaultCountry, nationalNumber: value };
  return {
    country: phone.country || defaultCountry,
    nationalNumber: phone.formatNational()
  };
}
