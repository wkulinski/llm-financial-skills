const NOISE_URL = /(?:gotow|samochod|kart|lokat|oszcz[eę]d|firm|biznes|rolnic|wsp[oó]lnot|dewelop|rachunk|konto)/i;
const NOISE_TITLE = /(?:gotow|samochod|karta|lokat|oszcz[eę]d|firm|biznes|rolnic|wsp[oó]not|dewelop)/i;
const DISCOVERY_CONTEXT = /(?:sitemap|mapa[-_ ]witryn|homepage|strona[-_ ]główna|^https?:\/\/[^/]+\/?$)/i;
const CALCULATOR = /(?:kalkulator|symulator|calculator)/i;

export function classifySourceRole(candidate = {}, categories = []) {
    const categorySet = new Set(categories);
    const productEvidence = categorySet.has('product') || categorySet.has('refinancing') || categorySet.has('fixed_rate');
    const urlOnly = candidate.url || candidate.final_url || '';
    const identity = `${urlOnly} ${candidate.title || ''}`;
    const noisyIdentity = NOISE_URL.test(identity) || NOISE_TITLE.test(candidate.title || '');

    if (DISCOVERY_CONTEXT.test(urlOnly) || /sitemap|mapa[-_ ]witryn|homepage|strona[-_ ]główna/i.test(candidate.title || '')) return 'discovery_context';
    if (CALCULATOR.test(identity)) return 'supporting';
    if (productEvidence && categorySet.has('product') && !noisyIdentity) return 'core';
    if (noisyIdentity && !categorySet.has('product')) return 'excluded_context';
    if (categorySet.has('pricing') || categorySet.has('documents')) return 'supporting';
    return 'context';
}

export function isDecisionEvidenceCategory(category) {
    return ['product', 'refinancing', 'fixed_rate', 'pricing'].includes(category);
}
