import { describe, expect, it } from 'vitest';
import { loadPullbackConfig } from './config';
import { recentQuarters } from './universe-refresh';
import {
  buildScreenUniverse,
  cleanWikiCell,
  parseNasdaq100,
  parseSp500,
  rankSp500,
  sp500Csv,
} from './universe';

const SP_RAW = `intro
{| class="wikitable sortable" id="constituents"
|-
![[Ticker symbol|Symbol]]
! Security !! Sector !! Sub-Industry !! HQ !! Date added !! CIK !! Founded
|-
|| {{NyseSymbol|AAAX}}
|| [[Acme Corp|Acme]]
|| Industrials
|| Machinery
|| [[Somewhere]]
|| 1990-01-01
|| 0000000001
|| 1900<ref>x</ref>
|-
|| {{NasdaqSymbol|BKX}}
|| [[Bee Kay]]
|| Tech || Software || [[Elsewhere]] || 2001-01-01 || 0000000002 || 1990
|-
|| {{NasdaqSymbol|BKXB}}
|| [[Bee Kay]] (Class B)
|| Tech || Software || [[Elsewhere]] || 2001-01-01 || 0000000002 || 1990
|-
|| {{NyseSymbol|CCX.B}}
|| [[Cee Cee]]
|| Financials || Insurance || [[Here]] || 1999-01-01 || 0000000003 || 1950
|}
`;

const NDX_RAW = `{| class="wikitable sortable" id="constituents"
|-
! Ticker !! Company !! ISIN !! Industry !! Subsector
|-
| BKX || [[Bee Kay]] (Class A) || {{ISIN|sl=n|US0000000001}} || Technology || Software
|-
| NDQX || [[Endee Q|Endee Quantum]] || {{ISIN|sl=n|US0000000002}} || Technology || Semis
|}`;

describe('Wikipedia constituent tables', () => {
  it('cleans wiki markup', () => {
    expect(cleanWikiCell('{{NyseSymbol|MMMX}}')).toBe('MMMX');
    expect(cleanWikiCell('[[Acme Corp|Acme]] <ref name="a">x</ref>')).toBe('Acme');
    expect(cleanWikiCell('{{ISIN|sl=n|US1}}')).toBe('');
  });

  it('parses S&P 500 rows (multi-line and single-line cells) with CIKs', () => {
    expect(parseSp500(SP_RAW)).toEqual([
      { symbol: 'AAAX', name: 'Acme', cik: '0000000001' },
      { symbol: 'BKX', name: 'Bee Kay', cik: '0000000002' },
      { symbol: 'BKXB', name: 'Bee Kay (Class B)', cik: '0000000002' },
      { symbol: 'CCX.B', name: 'Cee Cee', cik: '0000000003' },
    ]);
  });

  it('parses Nasdaq-100 rows and drops the share-class suffix from names', () => {
    expect(parseNasdaq100(NDX_RAW)).toEqual([
      { symbol: 'BKX', name: 'Bee Kay' },
      { symbol: 'NDQX', name: 'Endee Quantum' },
    ]);
  });
});

describe('rankSp500', () => {
  it('ranks by shares × close, one rank per company, unsized names unranked', () => {
    const ranked = rankSp500(
      parseSp500(SP_RAW),
      new Map([
        ['0000000001', 1_000],
        ['0000000002', 500],
      ]),
      new Map([
        ['AAAX', 10],
        ['BKX', 50],
        ['BKXB', 49],
        ['CCX.B', 400],
      ]),
      ['BKXB'],
    );
    expect(ranked.map((r) => [r.rank, r.symbol, r.marketCapUsd])).toEqual([
      [1, 'BKXB', 24_500], // preferred class of company 2
      [2, 'AAAX', 10_000],
      [null, 'BKX', 25_000], // same company, other class: not ranked separately
      [null, 'CCX.B', null], // no share count
    ]);
    expect(sp500Csv(ranked).split('\n')[1]).toBe('1,BKXB,Bee Kay (Class B),0000000002,24500');
  });
});

describe('buildScreenUniverse', () => {
  it('top-N S&P, Nasdaq-100, core, extra, holdings, watchlist; sources kept; exclude wins', () => {
    const cfg = {
      sp500Top: 1,
      nasdaq100: true,
      core: ['CORX', 'BKX'],
      extra: ['EXTX'],
      exclude: ['NOPE'],
    };
    const u = buildScreenUniverse(cfg, {
      sp500: [
        { rank: 1, symbol: 'AAAX', name: 'A', cik: '1', marketCapUsd: 2 },
        { rank: 2, symbol: 'ZZZX', name: 'Z', cik: '2', marketCapUsd: 1 },
      ],
      nasdaq100: [
        { symbol: 'BKX', name: 'B' },
        { symbol: 'NOPE', name: 'N' },
      ],
      held: ['HLDX', 'BKX'],
      watched: ['WTCX'],
    });
    expect(u).toEqual([
      { symbol: 'AAAX', sources: ['sp500'] },
      { symbol: 'BKX', sources: ['nasdaq100', 'core', 'holding'] },
      { symbol: 'CORX', sources: ['core'] },
      { symbol: 'EXTX', sources: ['extra'] },
      { symbol: 'HLDX', sources: ['holding'] },
      { symbol: 'WTCX', sources: ['watchlist'] },
    ]);
  });
});

describe('config and helpers', () => {
  it('loads config/pullbacks.json (comments stripped) with ascending tiers', () => {
    const cfg = loadPullbackConfig();
    expect(cfg.tiers).toEqual([20, 25, 30, 35]);
    expect(cfg.universe.sp500Top).toBe(100);
    expect(cfg.checks).toEqual({ open: '09:40', midday: '12:30' });
  });

  it('lists the most recent completed calendar quarters', () => {
    expect(recentQuarters('2026-11-17', 3)).toEqual(['CY2026Q3', 'CY2026Q2', 'CY2026Q1']);
    expect(recentQuarters('2027-01-05', 2)).toEqual(['CY2026Q4', 'CY2026Q3']);
  });
});
