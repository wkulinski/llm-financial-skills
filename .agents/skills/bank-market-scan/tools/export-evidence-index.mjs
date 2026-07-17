#!/usr/bin/env node
import path from 'node:path';
import {Command} from 'commander';
import ExcelJS from 'exceljs';
import {readJsonl, boolToPl, ensureDir, dataPath} from './lib/common.mjs';

const program = new Command();
program.option('--evidence <path>', 'evidence JSONL', dataPath('work/evidence.jsonl')).option('--out <path>', 'output XLSX', dataPath('exports/evidence-index.xlsx')).parse(process.argv);
const opts = program.opts();
const evidence = await readJsonl(opts.evidence);
const rows = evidence.map(e => ({
    'Evidence ID': e.evidence_id || '',
    'Lp': e.lp || '',
    'Institution ID': e.institution_id,
    'Kategoria': e.category || '',
    'Pole': e.field_path || '',
    'URL': e.url || '',
    'Typ źródła': e.source_type || '',
    'Data pobrania': e.fetched_at || '',
    'SHA-256 źródła': e.content_sha256 || '',
    'Wykorzystane do decyzji': boolToPl(e.used_for_decision),
    'Fragment / opis': e.text_excerpt || e.notes || ''
}));
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Evidence');
const headers = rows.length ? Object.keys(rows[0]) : ['Evidence ID', 'Lp', 'Institution ID', 'Kategoria', 'Pole', 'URL', 'Typ źródła', 'Data pobrania', 'SHA-256 źródła', 'Wykorzystane do decyzji', 'Fragment / opis'];
ws.addRow(headers);
for (const r of rows) ws.addRow(headers.map(h => r[h]));
ws.getRow(1).font = {bold: true};
ws.views = [{state: 'frozen', ySplit: 1}];
for (let i = 1; i <= ws.columnCount; i++) ws.getColumn(i).width = i <= 5 ? 18 : 32;
await ensureDir(path.dirname(opts.out));
await wb.xlsx.writeFile(opts.out);
console.log(opts.out);
