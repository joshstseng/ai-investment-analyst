/** @jsxRuntime automatic @jsxImportSource react */
/**
 * Component gallery for `pnpm email:preview` (made-up tickers and numbers). Shows every shared
 * component once, in the order a digest uses them.
 */
import {
  AttentionCard,
  Box,
  color,
  EmailShell,
  FilingsList,
  Footer,
  Header,
  HeadlinesList,
  KpiTiles,
  Note,
  PositionsTable,
  Section,
  signedPct,
} from '../src';

export default function Gallery() {
  return (
    <EmailShell preview="ETFX 17.5% off high · BKX new low · ACMX Q3 8-K">
      <Header
        kicker="AI Investment Analyst"
        title="📊 Component gallery"
        subtitle="Mon, Nov 16 · close · sample data"
      >
        <KpiTiles
          wideFirst
          tiles={[
            {
              label: 'Portfolio today',
              value: '−$1,203',
              valueColor: color.lossOnNavy,
              sub: '−2.4% · value $48,210',
              subColor: color.lossSubOnNavy,
            },
            { label: 'Alerts', value: '4', sub: 'all 📝 review' },
            { label: 'Active', value: '3', sub: 'conditions' },
            { label: 'Filings', value: '6', sub: '1 earnings 8-K' },
          ]}
        />
      </Header>

      <Section emoji="🎯" title="Needs attention">
        <AttentionCard
          severity="review"
          ticker="ETFX"
          pills={[
            { label: 'placeholder', tone: 'neutral' },
            { label: 'escalated', tone: 'escalated' },
          ]}
          price="$99.00"
          changePct={-3.0}
          body={
            <>
              17.5% below the 52-week high ($120.00), crossing the <b>15% tier</b>. Next tier (20%)
              at $96.00.
            </>
          }
          range={{ left: '20% $96.00', right: 'high $120.00', markerPct: 13 }}
          footer={
            <>
              Your position: 140 sh across 2 lots ·{' '}
              <span style={{ color: color.loss }}>−$742 (−5.1%)</span> · 31% of portfolio
            </>
          }
        />
        <AttentionCard
          severity="action"
          ticker="BKX"
          pills={[{ label: 'confirmed', tone: 'neutral' }]}
          price="$44.10"
          changePct={-4.2}
          body="Closed below the $45.00 stop. Plan: exit all 20 shares."
          range={{ left: 'stop $45.00', right: 'take-profit $60.00', markerPct: 0 }}
          footer="Your position: 20 sh @ $50.00 · −$118 (−11.8%)"
        />
        <AttentionCard
          severity="warning"
          ticker="WRNX"
          pills={[{ label: 'confirmed', tone: 'neutral' }]}
          price="$31.90"
          changePct={-1.1}
          body="Closed at or below the $32.00 warning level (stop $30.00)."
          range={{ left: 'stop $30.00', right: 'take-profit $40.00', markerPct: 19 }}
        />
        <AttentionCard
          severity="review"
          ticker="SPCQ"
          compact
          price="$4.20"
          changePct={-5.8}
          body="new 52-week closing low (was $4.50)"
          footer={<span style={{ color: color.loss }}>position −$415 (−36.8%)</span>}
        />
        <AttentionCard
          severity="reminder"
          ticker="OPTX"
          compact
          body="Year-end tax decision due Dec 15"
        />
        <Note>
          👀 <b>Levels to watch:</b> ACMX $27.30, 5.9% above its $25.70 draft stop · BKX $47.53,
          5.6% above its $45.00 stop
        </Note>
      </Section>

      <Section emoji="💼" title="Positions" note="sorted by today's move">
        <PositionsTable
          rows={[
            {
              ticker: 'GAINX',
              accountTag: 'R',
              price: '$42.00',
              dayPct: 0.3,
              value: '$840',
              plDollars: 140,
              plPct: 20.0,
              next: { text: 'stop $35.00 · 16.7%', pill: 'draft', near: false },
            },
            {
              ticker: 'LOTX',
              accountTag: 'R+I',
              lotLine: '12 @ 70.10 · 9 @ 84.40',
              price: '$83.90',
              dayPct: 0.3,
              value: '$1,762',
              plDollars: 56,
              plPct: 6.8,
              next: { text: 'cost $84.40 · 0.6%', pill: 'placeholder', near: true },
            },
            {
              ticker: 'ETFX',
              accountTag: 'R+I',
              lotLine: '2 lots · 140 sh',
              price: '$99.00',
              dayPct: -3.0,
              value: '$13,860',
              plDollars: -742,
              plPct: -5.1,
              next: { text: '20% tier · $96.00', pill: 'placeholder', near: true },
            },
            {
              ticker: 'FLATX',
              accountTag: 'I',
              price: '$63.25',
              dayPct: -3.3,
              value: '$506',
              plDollars: 22,
              plPct: 4.5,
              next: null,
            },
          ]}
        />
        <Note style={{ fontSize: 11, color: color.faint, marginTop: 6 }}>
          R = Roth IRA · I = Individual · "Next level" = nearest stop, tier, take-profit or 52w low
          and the distance to it
        </Note>
        <Box style={{ marginTop: 10 }}>
          <b>Options &amp; untracked:</b> OPTX Jan-28 $40C · OPTX $48.00{' '}
          <span style={{ color: color.gain }}>{signedPct(0.4)}</span>, 20% above strike · OTCQ · no
          data source
        </Box>
      </Section>

      <Section emoji="🏛️" title="SEC filings">
        <FilingsList
          items={[
            {
              tickers: ['ACMX'],
              title: '8-K · Q3 results',
              href: 'https://www.sec.gov/',
              strong: true,
              detail: '(Item 2.02) · Mon 1:06 PM',
            },
            {
              tickers: ['ACMX'],
              title: '10-Q · quarterly report',
              href: 'https://www.sec.gov/',
              detail: '· Mon 1:08 PM',
            },
            {
              tickers: ['BKX'],
              title: 'Form 4 · open-market sale',
              strong: true,
              lines: ['Jane Q Doe (CFO) sold 5,000 sh @ $46.10 avg ($230,500), 10b5-1 plan'],
            },
            {
              tickers: ['GAINX', 'ETFX', 'OPTX ×3'],
              title: 'Form 4 · insider filings · no open-market buys/sells',
            },
          ]}
        />
      </Section>

      <Section emoji="📰" title="Headlines" note="holdings · each story once">
        <HeadlinesList
          items={[
            {
              title: 'Regulators propose new rules for widget exports',
              href: 'https://example.com',
              source: 'example.com via Benzinga',
              day: 'Mon',
              tickers: ['ACMX', 'BKX', 'ETFX'],
              otherTickers: ['WTCH'],
            },
            {
              title: 'Court issues order against event-contract operators',
              source: 'example.org',
              day: 'Mon',
              tickers: ['GAINX'],
            },
            {
              title: 'Launch vehicle investigation continues',
              source: 'example.net',
              day: 'Sat',
              tickers: ['SPCQ'],
              extra: '+16 more SPCQ stories',
            },
          ]}
        />
        <Note>
          + 31 more holding headlines · 9 filtered as noise (e.g. "Actor named in new film role")
        </Note>
        <Box style={{ marginTop: 6 }}>
          <b>Watchlist:</b> WTCH 41 · WTCQ 6 stories · top:{' '}
          <i>Chipmakers fail to dismiss price-fixing suit</i>
        </Box>
      </Section>

      <Footer
        lines={[
          '🩺 Feeds OK · prices: Alpaca SIP daily bars · filings: SEC EDGAR · news: Benzinga',
          'Not checked: OTCQ (no data) · OPTX option value (no option prices)',
          'Generated Mon, Nov 16, 2:15 PM PT',
        ]}
      />
    </EmailShell>
  );
}
