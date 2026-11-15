/**
 * Made-up seed files in the same format as the real (gitignored) ones. No personal data.
 */
export const HOLDINGS_MD = `# Current Holdings: both accounts
**Source:** brokerage screenshots, as of Nov 12, 2026 ~4:33 PM ET.
**Combined value:** ≈ $10,000.

## Roth IRA (tax-advantaged)
Total $6,000.50. Cash $1,000.25, before the XYZ order.

| Ticker | Shares | Avg cost | Last (11/12) | Notes |
|---|---|---|---|---|
| AAA | 10 | $100.00 | $110.00 | |
| FRAC | 12.345 | $7.03 | $5.33 | Speculative |
| ETFX | 5 | $400.10 | $410.00 | ETF |
| XYZ | 3 | $50.00 (limit order placed; confirm fill) | — | |

## Individual account (taxable)
Total $4,000.00. Cash $86.10.

| Ticker | Shares | Avg cost | Last (11/12) | Notes |
|---|---|---|---|---|
| AAA | 2 | $120.50 | $110.00 | Second lot |
| ETFX | 4 + 6 = 10 | $49.90 / $50.20 | $50.10 | |
| OPTQ Mar-19-2027 $6 call | 1 contract | $1.95 | $0.03 | |
| OTCF | 50 | $3.02 | $1.95 | |
| CALLZ Jun-16-2028 $45 call | 1 contract | $12.35 | $10.90 | Underlying CALLZ |

## Concentration notes
- not an account
`;

export const POSITIONS_CSV = `ticker,name,type,entry_price,entry_date,why_i_own_it,thesis_break_triggers,catalyst_take_profit,valuation_trim_point,risk_stop,thesis_status,last_checked,notes
AAA,Alpha Corp,Stock,NEEDS USER INPUT,NEEDS USER INPUT,NEEDS USER INPUT,DRAFT PENDING,DRAFT PENDING,DRAFT PENDING,DRAFT PENDING (needs entry price),Unknown,2026-11-12,
OTCF,Otc Co plc (OTC; LSE:OTC),Stock,3.02,2026-05-20,User: reason,"CONFIRMED by user 2026-11-12: exit if guidance cut",CONFIRMED: if price > ~$5.50 sell half,See catalyst_take_profit (spike rule),CONFIRMED: exit on a daily close below $1.20,Weakening (reason changed),2026-11-12,"50 sh; cost $151.12; note"
OPTQ 2027-03-19 6C,Optq Mar-19-2027 $6 call,Option,1.95 (per share; $194.67 total),2026-05-15,User: upside,BROKEN 2026-11-12: customer missed target,n/a,n/a,n/a: little value left,Breaking,2026-11-12,1 contract
ALIAS,Alias Inc,Stock,NEEDS USER INPUT,NEEDS USER INPUT,NEEDS USER INPUT,DRAFT PENDING,DRAFT PENDING,DRAFT PENDING,DRAFT PENDING,Unknown,2026-11-12,
`;

export const WATCHLIST_CSV = `ticker,company_or_fund,date_added,status,thesis_summary,primary_catalyst,valuation_question,key_risk,review_by,latest_source_url,last_updated
WATCH,Watch Corp,2026-11-11,Researching,"Summary, with commas",Q4 results,Cheap?,Risk,2027-02-28,https://example.com/a,2026-11-11
`;

export const OVERRIDES = {
  aliases: { ALIAS: 'CALLZ Jun-16-2028 $45 call' },
  holdings: [
    { account: 'roth_ira', ticker: 'XYZ', needs_confirmation: true, confirmation_note: 'confirm' },
  ],
  theses: [{ ticker: 'XYZ', entry_price: '50.00', entry_date: '2026-11-12' }],
  rules: [
    {
      key: 'positions:OTCF:risk_stop',
      ticker: 'OTCF',
      purpose: 'risk_stop',
      status: 'CONFIRMED',
      rule_type: 'stop_close_below',
      params: { level: 1.2 },
    },
    {
      key: 'manual:FRAC:day_move',
      ticker: 'FRAC',
      purpose: 'monitor',
      status: 'PLACEHOLDER',
      rule_type: 'day_move_pct',
      params: { pct: 10 },
    },
    {
      key: 'manual:XYZ:trailing',
      ticker: 'XYZ',
      purpose: 'risk_stop',
      status: 'CONFIRMED',
      rule_type: 'trailing_close_pct_from_high',
      params: { pct: 20, start_date: null },
      needs_input: ['params.start_date'],
    },
  ],
};
