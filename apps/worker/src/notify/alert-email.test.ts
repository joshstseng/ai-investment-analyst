import { MAX_HTML_BYTES } from '@aia/emails';
import { describe, expect, it } from 'vitest';
import { composeHealthAlert, duration, healthAlertProps } from './health-alerts';
import { composeRuleAlert, planLines, ruleAlertProps, type RuleAlertInput } from './rule-alerts';

const now = new Date('2026-11-16T21:20:00Z'); // Mon 1:20 PM PST

const stopAlert: RuleAlertInput = {
  tag: 'ACTION',
  display: 'BKX',
  instrumentSymbol: 'BKX',
  evaluatedSymbol: 'BKX',
  name: 'Bookings Example Corp',
  ruleType: 'stop_close_below',
  status: 'CONFIRMED',
  purpose: 'risk_stop',
  outcome: {
    kind: 'fired',
    severity: 'critical',
    level: 'stop',
    message: 'BKX closed at $44.10, below the $45.00 stop',
    observed: { close: 44.1, level: 45, warnLevel: 46 },
    track: { kind: 'state', rank: 2, direction: 'down', price: 44.1 },
  },
  reason: 'first',
  alertNote: null,
  planAction: 'Exit all 20 shares on a daily close below $45.00.',
  judgment: 'Guidance cut or loss of the key contract.',
  lots: [{ account: 'roth_ira', quantity: '20', avgCost: '50.00', needsConfirmation: false }],
  prevClose: 46.03,
  siblings: [
    {
      ruleType: 'stop_close_below',
      status: 'CONFIRMED',
      params: { level: 45, warn_close_at_or_below: 46 },
    },
    { ruleType: 'take_profit_at_or_above', status: 'CONFIRMED', params: { level: 60 } },
  ],
  asOfDate: '2026-11-16',
  now,
};

const newLowAlert: RuleAlertInput = {
  ...stopAlert,
  tag: 'REVIEW',
  display: 'SPCQ',
  instrumentSymbol: 'SPCQ',
  evaluatedSymbol: 'SPCQ',
  name: 'Spec Quantum Inc',
  ruleType: 'new_52w_low',
  status: 'PLACEHOLDER',
  purpose: 'risk_stop',
  outcome: {
    kind: 'fired',
    severity: 'warn',
    level: 'new_low',
    message: 'SPCQ closed at $4.20, a new 52-week closing low (previous low $4.50)',
    observed: { close: 4.2, priorLowClose: 4.5 },
    track: { kind: 'state', rank: 1, direction: 'down', price: 4.2 },
  },
  reason: 'escalation_move',
  detail: '$4.35 → $4.20',
  planAction: null,
  judgment: null,
  lots: [{ account: 'roth_ira', quantity: '50', avgCost: '8.00', needsConfirmation: false }],
  prevClose: 4.44,
  siblings: [{ ruleType: 'new_52w_low', status: 'PLACEHOLDER', params: {} }],
};

describe('rule alert email', () => {
  it('ACTION: emoji subject, price and day %, range stop ↔ take-profit, position, planned action', () => {
    const p = ruleAlertProps(stopAlert);
    expect(p.subject).toBe('‼️ [AIA] ACTION BKX: closed below stop');
    expect(p.preview).toBe('$44.10 −4.2% · position −11.8%');
    expect(p).toMatchObject({
      severity: 'action',
      ticker: 'BKX',
      subtitle: 'Bookings Example Corp · Roth IRA',
      price: '$44.10',
      title: 'Closed below stop',
      body: 'BKX closed at $44.10, below the $45.00 stop.',
      range: { left: 'stop $45.00', right: 'take-profit $60.00', markerPct: 0 },
    });
    expect(p.position!.cells).toEqual([
      { label: 'Position', value: '20 sh @ $50.00' },
      { label: 'Value', value: '$882' },
      { label: 'P/L', value: '−$118 · −11.8%', tone: 'loss' },
    ]);
    expect(p.plan).toEqual([
      { label: 'Plan', text: 'Exit all 20 shares on a daily close below $45.00.' },
      { label: 'Also check', text: 'Guidance cut or loss of the key contract.' },
    ]);
    expect(p.footer[1]).toBe('As of the Mon, Nov 16 close · sent Mon, Nov 16, 1:20 PM PST');
  });

  it('CONFIRMED warning: says it is only the warning, and what happens at the stop', () => {
    const plan = planLines({
      ...stopAlert,
      tag: 'WARNING',
      outcome: { ...stopAlert.outcome, severity: 'warn', level: 'warning' },
    });
    expect(plan[0]).toEqual({
      label: 'Plan',
      text: 'Warning only; the stop is $45.00. At the stop: Exit all 20 shares on a daily close below $45.00.',
    });
  });

  it('CONFIRMED without a plan_action falls back to the rule itself', () => {
    expect(planLines({ ...stopAlert, planAction: null, judgment: null })).toEqual([
      { label: 'Plan', text: 'Exit per plan: daily close below $45.00.' },
    ]);
  });

  it('REVIEW: "review the position", notes missing confirmed rules, escalation in the body, low ↔ cost', () => {
    const p = ruleAlertProps(newLowAlert);
    expect(p.subject).toBe('📝 [AIA] REVIEW SPCQ: new 52-week closing low (further move)');
    expect(p.body).toBe(
      'SPCQ closed at $4.20, a new 52-week closing low (previous low $4.50). A further 2%+ move since the last alert ($4.35 → $4.20).',
    );
    expect(p.range).toEqual({ left: 'low $4.20', right: 'cost $8.00', markerPct: 0 });
    expect(p.plan[0]!.text).toBe(
      "Review the position. This is a PLACEHOLDER rule, so there's no confirmed exit plan yet. No exit rules are confirmed for SPCQ; consider writing one.",
    );
    // With a confirmed rule elsewhere on the instrument, no "write one" nudge.
    expect(
      planLines({
        ...newLowAlert,
        siblings: [{ ruleType: 'stop_close_below', status: 'CONFIRMED', params: { level: 5 } }],
      })[0]!.text,
    ).not.toContain('consider writing one');
  });

  it('options: price is the underlying, contracts, no value/P&L, lots per account', () => {
    const p = ruleAlertProps({
      ...newLowAlert,
      display: 'OPTX Jan-21-2028 $55 call',
      instrumentSymbol: 'OPTX280121C00055000',
      evaluatedSymbol: 'OPTX',
      name: null,
      isOption: true,
      lots: [
        { account: 'roth_ira', quantity: '1', avgCost: '20.00', needsConfirmation: false },
        { account: 'individual_taxable', quantity: '2', avgCost: '22.35', needsConfirmation: true },
      ],
    });
    expect(p).toMatchObject({ priceNote: 'OPTX', subtitle: 'Roth IRA + Individual' });
    expect(p.position).toEqual({
      cells: [{ label: 'Position', value: '3 contracts · 2 lots' }],
      lots: ['Roth IRA: 1 contract @ $20.00', 'Individual: 2 contracts @ $22.35'],
      note: 'Option value not shown (no option prices are collected). Fill not yet confirmed.',
    });
    expect(p.footer).toContain('Prices are the underlying OPTX (no option prices).');
  });

  it('REMINDER: the note is the subject, preview and plan', () => {
    const p = ruleAlertProps({
      ...stopAlert,
      tag: 'REMINDER',
      display: 'OTCX',
      ruleType: 'date_reminder',
      outcome: {
        ...stopAlert.outcome,
        level: 'reminder',
        message: 'Reminder for OTCX',
        observed: {},
        track: { kind: 'event' },
      },
      reason: 'event',
      alertNote: 'Decide whether to sell before year end.',
      planAction: null,
      judgment: null,
    });
    expect(p.subject).toBe('💡 [AIA] REMINDER OTCX: Decide whether to sell before year end.');
    expect(p.preview).toBe('Decide whether to sell before year end.');
    expect(p.plan).toEqual([{ label: 'Plan', text: 'Decide whether to sell before year end.' }]);
  });

  it('renders email-safe HTML and plain text (snapshots)', async () => {
    for (const [name, input] of [
      ['alert-action', stopAlert],
      ['alert-review', newLowAlert],
    ] as const) {
      const m = await composeRuleAlert(input);
      expect(m.html).not.toMatch(/<img|<svg|<script|<link[^>]+stylesheet/i);
      expect(Buffer.byteLength(m.html)).toBeLessThan(MAX_HTML_BYTES);
      await expect(m.html).toMatchFileSnapshot(`./__snapshots__/${name}.html`);
      await expect(m.text).toMatchFileSnapshot(`./__snapshots__/${name}.txt`);
    }
    const sample = await composeRuleAlert(newLowAlert);
    await expect(`${JSON.stringify(sample.props, null, 2)}\n`).toMatchFileSnapshot(
      '../../../../packages/emails/preview/alert-sample.json',
    );
  });
});

describe('HEALTH email', () => {
  const failure = {
    feed: 'alpaca_news_stream',
    kind: 'failure' as const,
    from: 'ok' as const,
    to: 'down' as const,
    detail: 'disconnected since 2026-11-16T17:42:00.000Z (connection limit exceeded)',
  };
  const others = [
    { feed: 'alpaca_news_stream', status: 'down' as const },
    { feed: 'alpaca_bars', status: 'ok' as const },
    { feed: 'sec_edgar', status: 'ok' as const },
    { feed: 'alpaca_quotes', status: 'degraded' as const },
  ];

  it('failure: what broke, since when, what it affects, what still works', () => {
    const p = healthAlertProps(failure, now, { since: now, others });
    expect(p.subject).toBe('🩺 [AIA] HEALTH News stream (Alpaca): down');
    expect(p.preview).toBe('down since Mon, Nov 16, 1:20 PM PST · Real-time headlines');
    expect(p.stillWorks).toBe('Daily bars (Alpaca), SEC EDGAR filings');
    expect(p.impact).toContain('News still arrives through the regular REST polls');
    expect(p.next).toContain('one more email when it recovers');
  });

  it('recovery: how long it was down', () => {
    const p = healthAlertProps(
      { ...failure, kind: 'recovery', from: 'down', to: 'ok', detail: 'connected' },
      now,
      { since: new Date(now.getTime() - (2 * 60 + 15) * 60_000), others },
    );
    expect(p.subject).toBe('🩺 [AIA] HEALTH News stream (Alpaca): recovered');
    expect(p.lead).toBe('News stream (Alpaca) is working again after 2h 15m.');
    expect(p.facts.map((f) => f.label)).toEqual(['Down from', 'Down for', 'Detail', 'Checked']);
    expect(p.stillWorks).toBeNull();
  });

  it('formats durations', () => {
    expect(duration(5 * 60_000)).toBe('5m');
    expect(duration(135 * 60_000)).toBe('2h 15m');
    expect(duration(3 * 24 * 3_600_000 + 2 * 3_600_000)).toBe('3d 2h');
  });

  it('renders (snapshots)', async () => {
    const m = await composeHealthAlert(failure, now, { since: now, others });
    expect(m.html).not.toMatch(/<img|<svg|<script/i);
    await expect(m.html).toMatchFileSnapshot('./__snapshots__/health-failure.html');
    await expect(m.text).toMatchFileSnapshot('./__snapshots__/health-failure.txt');
    await expect(`${JSON.stringify(m.props, null, 2)}\n`).toMatchFileSnapshot(
      '../../../../packages/emails/preview/health-sample.json',
    );
  });
});
