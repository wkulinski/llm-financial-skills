import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {describe, expect, it} from 'vitest';

const node = process.execPath;
const skillRoot = path.resolve('.agents/skills/bank-market-scan');

function makeProject() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-scope-'));
    fs.mkdirSync(path.join(root, 'data/base'), {recursive: true});
    fs.mkdirSync(path.join(root, 'data/work'), {recursive: true});
    fs.writeFileSync(path.join(root, 'data/base/institutions.current.json'), JSON.stringify({institutions: [{
        lp: 1,
        institution_id: 'bank_a',
        type: 'bank_spoldzielczy',
        name: 'Bank A',
        website_url: 'https://bank-a.example'
    }]}));
    fs.writeFileSync(path.join(root, 'data/work/analysis-state.json'), JSON.stringify({rows: [{
        lp: 1,
        institution_id: 'bank_a',
        review_status: 'unchecked',
        qualifies: null
    }]}));
    return root;
}

describe('reduced decision data scope', () => {
    it('exports only decision-relevant workbook columns', () => {
        const columns = JSON.parse(fs.readFileSync(path.join(skillRoot, 'schemas/workbook-columns.json'), 'utf8'));
        expect(columns).toHaveLength(26);
        const headers = columns.map(column => column.xlsx);
        expect(headers).toContain('Prowizja min');
        expect(headers).toContain('Oprocentowanie okresowo stałe min');
        expect(headers).toContain('RRSO min');
        expect(headers).toContain('Status decyzji');
        expect(headers).toContain('Okres stałego oprocentowania (lata) exact');
        for (const removed of [
            'WIBOR dla okresu stałego - tenor',
            'Marża dla okresu stałego - minimalna',
            'Wymagane konto',
            'Ubezpieczenie na życie wymagane',
            'Dokumenty dochodowe znalezione',
            'Początek promocji',
            'Uwagi badawcze'
        ]) expect(headers).not.toContain(removed);
    });

    it('does not collect secondary requirements or document evidence', () => {
        const keywords = JSON.parse(fs.readFileSync(path.join(skillRoot, 'schemas/evidence-keywords.json'), 'utf8'));
        expect(Object.keys(keywords)).toEqual(['product', 'refinancing', 'fixed_rate', 'pricing']);
        expect(keywords.requirements).toBeUndefined();
        expect(keywords.documents).toBeUndefined();
    });

    it('does not expose stale secondary evidence categories in the review pack', () => {
        const root = makeProject();
        const cache = path.join(root, 'data/cache/institutions/001-bank-a');
        fs.mkdirSync(cache, {recursive: true});
        fs.writeFileSync(path.join(cache, 'candidates.json'), JSON.stringify({
            institution_id: 'bank_a', lp: 1, name: 'Bank A', website_url: 'https://bank-a.example',
            candidates: [{url: 'https://bank-a.example/oferta', final_url: 'https://bank-a.example/oferta', title: 'Oferta', selected_seed: true, available: true, content_type: 'text/html', score: 3}],
            all_candidates: []
        }));
        fs.writeFileSync(path.join(cache, 'source-text.jsonl'), JSON.stringify({url: 'https://bank-a.example/oferta', source_type: 'html', fetched_at: '2026-07-14', text: 'Oferta'}));
        fs.writeFileSync(path.join(cache, 'evidence.candidates.jsonl'), [
            {url: 'https://bank-a.example/oferta', category: 'product', keyword: 'kredyt mieszkaniowy', text_excerpt: 'kredyt mieszkaniowy'},
            {url: 'https://bank-a.example/oferta', category: 'documents', keyword: 'wniosek', text_excerpt: 'wniosek'}
        ].map(JSON.stringify).join('\n') + '\n');
        execFileSync(node, [path.join(skillRoot, 'tools/prepare-review-pack.mjs'), '--lp', '1', '--skip-preprocess'], {cwd: root, env: {...process.env, BANK_MARKET_SCAN_PROJECT_ROOT: root}, encoding: 'utf8'});
        const pack = fs.readFileSync(path.join(root, 'data/work/review-packs/lp-001.md'), 'utf8');
        expect(pack).not.toContain('Fragmenty: dokumenty');
        expect(pack).toContain('Fragmenty: produkt mieszkaniowy/hipoteczny');
    });

    it('preserves HTML headings and competing values for LLM review', () => {
        const root = makeProject();
        const cache = path.join(root, 'data/cache');
        fs.mkdirSync(cache, {recursive: true});
        const htmlPath = path.join(cache, 'offer.html');
        fs.writeFileSync(htmlPath, '<html><body><h1>Oferta główna</h1><p>Oprocentowanie okresowo stałe: 6,30%.</p><h2>FAQ</h2><p>FAQ podaje 5,65%.</p></body></html>');
        fs.writeFileSync(path.join(cache, 'candidates.json'), JSON.stringify({
            institution_id: 'bank_a', lp: 1, name: 'Bank A', website_url: 'https://bank-a.example',
            candidates: [{url: 'https://bank-a.example/oferta', final_url: 'https://bank-a.example/oferta', title: 'Kredyt mieszkaniowy', cache_file: htmlPath, available: true, content_type: 'text/html', source: 'search', score: 5, fetched_at: '2026-07-14'}]
        }));
        execFileSync(node, [path.join(skillRoot, 'tools/extract-text.mjs'), '--cache-dir', cache], {cwd: root, env: {...process.env, BANK_MARKET_SCAN_PROJECT_ROOT: root}, encoding: 'utf8'});
        const source = JSON.parse(fs.readFileSync(path.join(cache, 'source-text.jsonl'), 'utf8').trim());
        expect(source.text).toMatch(/# oferta główna/i);
        expect(source.text).toMatch(/# FAQ/i);
        expect(source.text).toContain('6,30%');
        expect(source.text).toContain('5,65%');
    });
});
