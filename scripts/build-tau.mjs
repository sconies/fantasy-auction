// Week-to-week noise per category from the latest season's game logs (data/history/weekly-T.json).
// The app adds it to each category's spread between players: head-to-head G-scores (scripts/simulate-h2h.mjs).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { computeValues } from '../lib/value.mjs';
import { weeklyTau, seasonLines } from '../lib/h2h.mjs';
const season = +(process.argv[2] ?? 2026);
const W = JSON.parse(readFileSync(`data/history/weekly-${season}.json`, 'utf8'));
const tau = weeklyTau(W, computeValues(seasonLines(W)).slice(0, 182));
mkdirSync('data/model', { recursive: true });
writeFileSync('data/model/tau.json', JSON.stringify({ fromSeason: season, note: 'Average within-player variance of weekly per-game rates, top-182 players', tau }, null, 1) + '\n');
console.log(tau);
