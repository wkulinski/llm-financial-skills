import {createRequire} from 'node:module';
import * as cheerio from 'cheerio';
import {htmlToText} from 'html-to-text';
import {cleanWhitespace, sha256} from './common.mjs';

const require = createRequire(import.meta.url);
const pdfParse = require('pdf-parse');

export async function normalizeMaterial(buffer, {contentType = '', fileName = ''} = {}) {
    let text;
    if (/\.pdf$/i.test(fileName) || /pdf/i.test(contentType)) {
        const parsed = await pdfParse(buffer);
        text = parsed.text || '';
    } else {
        const $ = cheerio.load(Buffer.from(buffer).toString('utf8'));
        $('script,style,nav,footer,header,form,noscript,svg').remove();
        text = htmlToText($.html(), {
            wordwrap: false,
            selectors: [{selector: 'a', options: {ignoreHref: true}}]
        });
    }
    const normalizedText = cleanWhitespace(text);
    return {
        text: normalizedText,
        material_sha256: sha256(normalizedText)
    };
}
