import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import ExcelJS from 'exceljs';
import {describe, expect, it} from 'vitest';

const node = process.execPath;
const root = path.resolve('.');

function tmpFile(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-skill-'));
    return {dir, file: path.join(dir, name)};
}

describe('minimal JSON -> update -> validate -> XLSX flow', () => {
    it('runs critical CLI tools on a tiny fixture', async () => {
        const {dir} = tmpFile('x');
        const institutionsPath = path.join(dir, 'institutions.json');
        const statePath = path.join(dir, 'state.json');
        const updatePath = path.join(dir, 'update.json');
        const evidencePath = path.join(dir, 'evidence.jsonl');
        const outXlsx = path.join(dir, 'out.xlsx');
        fs.writeFileSync(institutionsPath, JSON.stringify({
            schema_version: '1.0', institutions: [
                {
                    lp: 1,
                    institution_id: 'bank_a',
                    type: 'bank_spoldzielczy',
                    name: 'Bank A',
                    website_url: 'https://bank-a.example',
                    source: {}
                }
            ]
        }));
        fs.writeFileSync(statePath, JSON.stringify({
            schema_version: '1.1', rows: [
                {lp: 1, institution_id: 'bank_a', review_status: 'unchecked', qualifies: null}
            ]
        }));
        fs.writeFileSync(updatePath, JSON.stringify({
            lp: 1,
            institution_id: 'bank_a',
            review_status: 'checked',
            checked_at: '2026-07-06',
            website_available: true,
            qualifies: true,
            qualification: {
                housing_or_mortgage_loan_confirmed: true,
                refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed: true,
                periodically_fixed_rate_confirmed: true,
                reason_codes: ['housing_or_mortgage_loan_confirmed', 'refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed', 'periodically_fixed_rate_confirmed']
            },
            decision_audit: {
                product_scope: 'Kredyt testowy',
                same_product_variant_confirmed: true,
                criterion_evidence_urls: {
                    housing: ['https://bank-a.example'],
                    refinancing: ['https://bank-a.example'],
                    fixed_rate: ['https://bank-a.example']
                }
            },
            offer: {
                product_name: 'Kredyt testowy',
                fixed_nominal_rate_exact: 0.061,
                rrso_exact: 0.071,
                rrso_description: 'Wariant z oprocentowaniem okresowo stałym',
                commission_exact: 0.01
            },
            field_evidence: {
                'qualification.housing_or_mortgage_loan_confirmed': [{
                    url: 'https://bank-a.example',
                    text_excerpt: 'kredyt mieszkaniowy'
                }],
                'qualification.refinance_or_repayment_of_previous_housing_mortgage_loan_confirmed': [{
                    url: 'https://bank-a.example',
                    text_excerpt: 'spłata wcześniejszego kredytu mieszkaniowego'
                }],
                'qualification.periodically_fixed_rate_confirmed': [{
                    url: 'https://bank-a.example',
                    text_excerpt: 'oprocentowanie okresowo stałe'
                }]
            }
        }));
        fs.writeFileSync(evidencePath, '');

        const next = execFileSync(node, ['.agents/skills/bank-market-scan/tools/next-batch.mjs', '--institutions', institutionsPath, '--state', statePath, '--n', '1'], {
            cwd: root,
            encoding: 'utf8'
        });
        expect(next).toContain('bank_a');
        execFileSync(node, ['.agents/skills/bank-market-scan/tools/apply-row-update.mjs', '--input', updatePath, '--state', statePath, '--no-backup'], {
            cwd: root,
            encoding: 'utf8'
        });
        const validate = execFileSync(node, ['.agents/skills/bank-market-scan/tools/validate-state.mjs', '--state', statePath, '--require-field-evidence'], {
            cwd: root,
            encoding: 'utf8'
        });
        expect(validate).toContain('"warnings_count": 0');
        execFileSync(node, ['.agents/skills/bank-market-scan/tools/export-workbook.mjs', '--institutions', institutionsPath, '--analysis', statePath, '--evidence', evidencePath, '--out', outXlsx], {
            cwd: root,
            encoding: 'utf8'
        });
        expect(fs.existsSync(outXlsx)).toBe(true);

        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(outXlsx);
        const worksheet = workbook.getWorksheet('Analiza ofert');
        const headers = worksheet.getRow(1).values.slice(1);
        expect(headers).not.toContain('Prowizja konkretna');
        expect(headers).not.toContain('Oprocentowanie okresowo stałe konkretne');
        expect(headers).not.toContain('RRSO konkretne');
        for (const removedHeader of [
            'Źródło listy bazowej',
            'Data aktualizacji BFG',
            'Uwagi z listy bazowej',
            'Kody powodów TAK',
            'Kody powodów NIE',
            'URL tabeli oprocentowania',
            'URL taryfy opłat/prowizji',
            'URL dokumentów/formularzy',
            'Status pola: kredyt mieszkaniowy/hipoteczny',
            'Status pola: refinansowanie/spłata',
            'Status pola: okresowo stałe oprocentowanie',
            'Liczba dowodów per-pole',
            'Podstawa ustalenia'
        ]) {
            expect(headers).not.toContain(removedHeader);
        }
        expect(headers).toContain('Prowizja min');
        expect(headers).toContain('Prowizja max');
        expect(headers).toContain('Oprocentowanie okresowo stałe min');
        expect(headers).toContain('Oprocentowanie okresowo stałe max');
        expect(headers).toContain('RRSO min');
        expect(headers).toContain('RRSO max');

        const values = worksheet.getRow(2).values.slice(1);
        const valueFor = header => values[headers.indexOf(header)];
        expect(valueFor('Prowizja min')).toBe(0.01);
        expect(valueFor('Prowizja max')).toBe(0.01);
        expect(valueFor('Oprocentowanie okresowo stałe min')).toBe(0.061);
        expect(valueFor('Oprocentowanie okresowo stałe max')).toBe(0.061);
        expect(valueFor('RRSO min')).toBe(0.071);
        expect(valueFor('RRSO max')).toBe(0.071);
    });
});
