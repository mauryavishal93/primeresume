export function preferredPricingCurrency() {
  return 'INR';
}

export function formatCurrencyPrice(amount, currency, locale = globalThis.navigator?.language || 'en-US') {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: currency === 'USD' ? 2 : 0,
    maximumFractionDigits: currency === 'USD' ? 2 : 0
  }).format(amount);
}
