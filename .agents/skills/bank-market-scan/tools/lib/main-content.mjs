import * as cheerio from 'cheerio';

const ROOT_SELECTORS = [
    'main',
    'article',
    '[role="main"]',
    '.entry-content',
    '.post-content',
    '.page-content',
    '.site-main',
    '.content-area',
    '#content'
];

const REMOVE_SELECTOR = [
    'script',
    'style',
    'nav',
    'footer',
    'header',
    'aside',
    'form',
    'noscript',
    'svg',
    '[role="navigation"]',
    '[aria-label*="cookie" i]',
    '[class*="cookie" i]',
    '[id*="cookie" i]',
    '[class*="share" i]',
    '[class*="social" i]',
    '[class*="breadcrumb" i]'
].join(',');

const BLOCK_TAGS = new Set([
    'address', 'blockquote', 'div', 'dl', 'fieldset', 'figcaption', 'figure',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre', 'section',
    'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul'
]);

const DOMAIN_SIGNAL_RE = /kredyt|mieszk|hipot|oprocent|refinans|spłat|splat|stał|stal/i;

function textFromNode(node) {
    if (node.type === 'text') return node.data || '';
    if (node.type !== 'tag' && node.type !== 'root') return '';

    const tag = String(node.name || '').toLowerCase();
    if (tag === 'br') return '\n';
    const content = (node.children || []).map(textFromNode).join('');
    const prefix = /^h[1-6]$/.test(tag) ? `${'#'.repeat(Number(tag.slice(1)))} ` : (tag === 'li' ? '- ' : '');
    return BLOCK_TAGS.has(tag) ? `\n${prefix}${content}\n` : content;
}

function cleanRoot($, root) {
    const clone = $(root).clone();
    clone.find(REMOVE_SELECTOR).remove();
    if (clone.is(REMOVE_SELECTOR)) clone.remove();
    return clone;
}

function normalizeExtractedText(value) {
    return String(value || '')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n[ \t]+/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function scoreCandidate($, root, text) {
    const compactLength = text.replace(/\s/g, '').length;
    const linkTextLength = $(root).find('a').toArray().reduce((sum, node) => sum + $(node).text().trim().length, 0);
    const linkDensity = compactLength ? linkTextLength / compactLength : 1;
    const headings = $(root).find('h1,h2,h3,h4,h5,h6').length;
    const lists = $(root).find('ul,ol').length;
    const tables = $(root).find('table').length;
    const className = `${$(root).attr('id') || ''} ${$(root).attr('class') || ''}`;
    const contentNameBoost = /content|article|main|offer|product|kredyt/i.test(className) ? 4 : 0;
    return Math.log1p(compactLength) + headings * 1.5 + lists + tables * 2 + contentNameBoost - linkDensity * 12;
}

export function extractMainContent(html) {
    const $ = cheerio.load(String(html || ''));
    const body = $('body')[0] || $('html')[0] || $.root()[0];
    const bodyClone = cleanRoot($, body);
    const fallbackText = normalizeExtractedText(textFromNode(bodyClone[0]));
    const candidates = [];
    const seen = new Set();

    for (const selector of ROOT_SELECTORS) {
        $(selector).each((_, root) => {
            if (seen.has(root)) return;
            seen.add(root);
            const clone = cleanRoot($, root);
            const text = normalizeExtractedText(textFromNode(clone[0]));
            if (text.length < 200) return;
            candidates.push({selector, text, score: scoreCandidate($, clone[0], text)});
        });
    }

    candidates.sort((left, right) => right.score - left.score);
    const selected = candidates[0] || null;
    const selectedHasSignal = selected ? DOMAIN_SIGNAL_RE.test(selected.text) : false;
    const fallbackHasSignal = DOMAIN_SIGNAL_RE.test(fallbackText);
    const fallbackUsed = !selected || selected.text.length < 200 || (!selectedHasSignal && fallbackHasSignal);
    const text = fallbackUsed ? fallbackText : selected.text;
    const mode = fallbackUsed ? 'cleaned_body' : 'main_content';

    return {
        text,
        links: $('a[href]').toArray().map(anchor => $(anchor).attr('href')).filter(Boolean),
        extraction: {
            mode,
            fallback_used: fallbackUsed,
            fallback_reason: !selected
                ? 'no_main_candidate'
                : (selected.text.length < 200 ? 'main_candidate_too_short' : (!selectedHasSignal && fallbackHasSignal ? 'main_candidate_lost_domain_signal' : null)),
            selector: fallbackUsed ? 'body' : selected.selector,
            source_characters: fallbackText.length,
            selected_characters: selected?.text.length || 0,
            removed_characters: Math.max(0, fallbackText.length - text.length),
            candidate_count: candidates.length,
            score: selected?.score || null
        }
    };
}
