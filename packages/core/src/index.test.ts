import { describe, expect, it } from 'vitest';
import {
  canonical,
  decimalEquals,
  addDays,
  inEdgarWindow,
  isIsoDate,
  nyDate,
  isRuleToWrite,
  occSymbol,
  optionLabel,
  parseDecimal,
  parseOptionDescriptor,
  parseRuleParams,
  ruleAlertLabel,
  sumDecimals,
  zonedTimeToUtc,
} from './index';

describe('decimal', () => {
  it.each([
    ['$1,234.56', '1234.56'],
    ['12.345', '12.345'],
    ['9', '9'],
    ['$61.03', '61.03'],
    ['8.1230', '8.123'],
  ])('parseDecimal(%s) = %s', (input, expected) => {
    expect(parseDecimal(input)).toBe(expected);
  });

  it.each(['NEEDS USER INPUT', '', '1 contract', '$1.95 (x)', '1.2.3'])('rejects %j', (input) => {
    expect(parseDecimal(input)).toBeNull();
  });

  it('sums exactly and compares across scales', () => {
    expect(sumDecimals(['4', '6'])).toBe('10');
    expect(sumDecimals(['0.1', '0.2'])).toBe('0.3');
    expect(decimalEquals('12.345000', '12.345')).toBe(true);
    expect(canonical('50.100000')).toBe('50.1');
  });

  it('rejects more than 6 decimal places', () => {
    expect(() => canonical('1.0000001')).toThrow();
  });
});

describe('options', () => {
  it('parses the holdings.md and positions.csv forms to the same contract', () => {
    const a = parseOptionDescriptor('OPTY Mar-19-2027 $6 call');
    const b = parseOptionDescriptor('OPTY 2027-03-19 6C');
    expect(a).toEqual({ underlying: 'OPTY', right: 'call', strike: '6', expiry: '2027-03-19' });
    expect(b).toEqual(a);
    expect(occSymbol(a!)).toBe('OPTY270319C00006000');
  });

  it('handles puts, decimal strikes and labels', () => {
    const o = parseOptionDescriptor('XYZ Mar-5-2027 $12.5 put')!;
    expect(occSymbol(o)).toBe('XYZ270305P00012500');
    expect(optionLabel(o)).toBe('XYZ Mar-05-2027 $12.5 put');
    expect(occSymbol(parseOptionDescriptor('OPTX Jun-16-2028 $45 call')!)).toBe(
      'OPTX280616C00045000',
    );
  });

  it.each(['AAPL', 'OPTY Feb-30-2027 $4 call', 'OPTY Foo-15-2027 $4 call', 'OPTY 2027-03-19 6X'])(
    'returns null for %j',
    (s) => {
      expect(parseOptionDescriptor(s)).toBeNull();
    },
  );
});

describe('time', () => {
  it('converts New York wall clock to UTC across DST', () => {
    // Nov 12, 2026 is EST (UTC-5); Jul 1, 2026 is EDT (UTC-4).
    expect(
      zonedTimeToUtc(
        { year: 2026, month: 11, day: 12, hour: 16, minute: 33 },
        'America/New_York',
      ).toISOString(),
    ).toBe('2026-11-12T21:33:00.000Z');
    expect(
      zonedTimeToUtc(
        { year: 2026, month: 7, day: 1, hour: 9, minute: 30 },
        'America/New_York',
      ).toISOString(),
    ).toBe('2026-07-01T13:30:00.000Z');
  });

  it('gives the New York trading date of an instant', () => {
    // Alpaca daily bars are stamped at midnight ET, i.e. 05:00Z in winter.
    expect(nyDate(new Date('2026-11-13T05:00:00Z'))).toBe('2026-11-13');
    expect(nyDate(new Date('2026-11-13T03:00:00Z'))).toBe('2026-11-12');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('knows the EDGAR polling window in Pacific time, across DST', () => {
    expect(inEdgarWindow(new Date('2026-11-16T12:59:00Z'))).toBe(false); // 4:59 AM PST
    expect(inEdgarWindow(new Date('2026-11-16T13:00:00Z'))).toBe(true); // 5:00 AM PST
    expect(inEdgarWindow(new Date('2026-11-17T04:59:00Z'))).toBe(true); // 8:59 PM PST
    expect(inEdgarWindow(new Date('2026-11-17T05:00:00Z'))).toBe(false); // 9:00 PM PST
    expect(inEdgarWindow(new Date('2026-07-01T12:00:00Z'))).toBe(true); // 5:00 AM PDT
  });

  it('validates ISO dates', () => {
    expect(isIsoDate('2026-11-12')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('11/12/2026')).toBe(false);
  });
});

describe('rule params', () => {
  it('accepts valid params and rejects bad ones', () => {
    expect(
      parseRuleParams('stop_close_below', { level: 96.28, warn_close_at_or_below: 100 }),
    ).toEqual({ level: 96.28, warn_close_at_or_below: 100 });
    expect(() =>
      parseRuleParams('stop_close_below', { level: 150, warn_close_at_or_below: 140 }),
    ).toThrow();
    expect(() => parseRuleParams('day_move_pct', { pct: 7, extra: 1 })).toThrow();
    expect(() => parseRuleParams('etf_drawdown_from_52w_high', { tiers: [15, 10] })).toThrow();
    expect(() => parseRuleParams('option_value_below', { level: 11 })).toThrow();
    expect(parseRuleParams('trailing_close_pct_from_high', { pct: 20, start_date: null })).toEqual({
      pct: 20,
      start_date: null,
    });
  });

  it('accepts take-profit end dates and date reminders', () => {
    expect(
      parseRuleParams('take_profit_at_or_above', {
        level: 14.5,
        basis: 'high_or_close',
        valid_until: '2027-03-03',
      }).valid_until,
    ).toBe('2027-03-03');
    expect(parseRuleParams('date_reminder', { on: '2026-12-10' })).toEqual({ on: '2026-12-10' });
    expect(() => parseRuleParams('date_reminder', { on: '2026-12-32' })).toThrow();
  });

  it('separates rules to write from typed placeholders', () => {
    expect(isRuleToWrite({ ruleType: null, thesisBreakTriggers: null })).toBe(true);
    expect(isRuleToWrite({ ruleType: 'day_move_pct', thesisBreakTriggers: null })).toBe(false);
    expect(isRuleToWrite({ ruleType: null, thesisBreakTriggers: 'equity raise' })).toBe(false);
  });

  it('labels alerts by status', () => {
    expect(ruleAlertLabel('CONFIRMED')).toBe('action per plan');
    expect(ruleAlertLabel('DRAFT')).toBe('review');
    expect(ruleAlertLabel('PLACEHOLDER')).toBe('review');
  });
});
