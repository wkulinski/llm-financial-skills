#!/usr/bin/env node
import {readJson, dataPath} from './lib/common.mjs';

const institutions = await readJson(dataPath('base/institutions.current.json'));
const state = await readJson(dataPath('work/analysis-state.json'));
const rows = state.rows;
const checked = rows.filter(r => r.review_status === 'checked');
const yes = checked.filter(r => r.qualifies === true).length;
const no = checked.filter(r => r.qualifies === false).length;
const unknown = checked.filter(r => r.qualifies == null).length;
const unavailable = checked.filter(r => r.website_available === false).length;
const last = Math.max(0, ...checked.map(r => r.lp || 0));
console.log(`Razem: ${institutions.institutions.length}`);
console.log(`Sprawdzone: ${checked.length}`);
console.log(`TAK: ${yes}`);
console.log(`NIE: ${no}`);
console.log(`Brak kwalifikacji/puste: ${unknown}`);
console.log(`Strona niedostępna: ${unavailable}`);
console.log(`Do sprawdzenia: ${institutions.institutions.length - checked.length}`);
console.log(`Ostatnia sprawdzona Lp.: ${last}`);
