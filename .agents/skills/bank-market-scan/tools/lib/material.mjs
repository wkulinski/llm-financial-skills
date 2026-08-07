import {createRequire} from 'node:module';
import {cleanWhitespace, sha256} from './common.mjs';
import {extractMainContent} from './main-content.mjs';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

export async function normalizeMaterial(buffer, {contentType = '', fileName = ''} = {}) {
    let text;
    let extraction;
    let links = [];
    if (/\.pdf$/i.test(fileName) || /pdf/i.test(contentType)) {
        const parsed = await pdfParse(buffer);
        text = parsed.text || '';
        extraction = {mode: 'pdf', fallback_used: false};
    } else {
        const extracted = extractMainContent(Buffer.from(buffer).toString('utf8'));
        text = extracted.text;
        links = extracted.links;
        extraction = extracted.extraction;
    }
    const normalizedText = cleanWhitespace(text);
    return {
        text: normalizedText,
        material_sha256: sha256(normalizedText),
        links,
        extraction
    };
}
