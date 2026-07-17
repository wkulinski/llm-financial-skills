const NOISE_URL = /(?:gotow|samochod|kart|lokat|oszcz[eę]d|firm|biznes|rolnic|wsp[oó]lnot|dewelop|rachunk|konto)/i;
const NOISE_TITLE = /(?:gotow|samochod|karta|lokat|oszcz[eę]d|firm|biznes|rolnic|wsp[oó]not|dewelop)/i;

export function classifySourceRole(candidate = {}, categories = []) {
    const categorySet = new Set(categories);
    const productEvidence = categorySet.has('product') || categorySet.has('refinancing') || categorySet.has('fixed_rate');
    const noisyIdentity = NOISE_URL.test(candidate.url || candidate.final_url || '') || NOISE_TITLE.test(candidate.title || '');

    if (productEvidence && !noisyIdentity) return 'core';
    if (productEvidence && categorySet.has('product') && !NOISE_URL.test(candidate.url || candidate.final_url || '')) return 'core';
    if (noisyIdentity && !categorySet.has('product')) return 'excluded_context';
    if (categorySet.has('pricing') || categorySet.has('documents')) return 'supporting';
    return 'context';
}

export function isDecisionEvidenceCategory(category) {
    return ['product', 'refinancing', 'fixed_rate', 'pricing'].includes(category);
}
