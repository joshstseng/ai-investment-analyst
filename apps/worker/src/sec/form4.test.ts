import { describeFiling } from '@aia/core';
import { describe, expect, it } from 'vitest';
import { displayName, form4XmlUrl, parseForm4Xml, summarizeTrades } from './form4';

/** A made-up Form 4: one officer/director with an open-market sale under a 10b5-1 plan,
 *  a buy, tax withholding, and an option exercise in the derivative table. */
const XML = `<?xml version="1.0"?>
<ownershipDocument>
  <issuer><issuerTradingSymbol>ACMX</issuerTradingSymbol></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerName>DOE JANE Q</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>1</isDirector><isOfficer>1</isOfficer><officerTitle>Chief Financial Officer</officerTitle>
    </reportingOwnerRelationship>
  </reportingOwner>
  <aff10b5One>1</aff10b5One>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-11-12</value></transactionDate>
      <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>1500</value></transactionShares>
        <transactionPricePerShare><value>101.25</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-11-13</value></transactionDate>
      <transactionCoding><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>200</value></transactionShares>
        <transactionPricePerShare><value>99.5</value></transactionPricePerShare>
      </transactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <transactionCoding><transactionCode>F</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>300</value></transactionShares></transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
  <derivativeTable>
    <derivativeTransaction>
      <transactionCoding><transactionCode>M</transactionCode></transactionCoding>
    </derivativeTransaction>
  </derivativeTable>
</ownershipDocument>`;

describe('parseForm4Xml', () => {
  it('lists open-market buys and sales with name, role, shares, price and value', () => {
    const s = parseForm4Xml(XML);
    expect(s.owners).toEqual([{ name: 'Jane Q Doe', role: 'Chief Financial Officer, Director' }]);
    expect(s.trades).toEqual([
      {
        code: 'S',
        date: '2026-11-12',
        shares: 1500,
        price: 101.25,
        value: 151875,
        owner: 'Jane Q Doe',
        role: 'Chief Financial Officer, Director',
        plan10b51: true,
      },
      {
        code: 'P',
        date: '2026-11-13',
        shares: 200,
        price: 99.5,
        value: 19900,
        owner: 'Jane Q Doe',
        role: 'Chief Financial Officer, Director',
        plan10b51: true,
      },
    ]);
  });

  it('counts every other transaction code (non-derivative and derivative)', () => {
    expect(parseForm4Xml(XML).otherCounts).toEqual({ F: 1, M: 1 });
  });

  it('handles a gift-only filing with no buys or sales', () => {
    const gift = XML.replace(
      /<nonDerivativeTable>[\s\S]*<\/nonDerivativeTable>/,
      `<nonDerivativeTable><nonDerivativeTransaction><transactionCoding><transactionCode>G</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>500000</value></transactionShares><transactionPricePerShare><value>0</value></transactionPricePerShare></transactionAmounts></nonDerivativeTransaction></nonDerivativeTable>`,
    );
    const s = parseForm4Xml(gift);
    expect(s.trades).toEqual([]);
    expect(s.otherCounts).toEqual({ G: 1, M: 1 });
  });

  it('rejects documents that are not Form 4 XML', () => {
    expect(() => parseForm4Xml('<html><body>Not found</body></html>')).toThrow(/not a Form 4/);
  });

  it('formats SEC surname-first names and builds the raw XML URL', () => {
    expect(displayName('DOE JANE Q')).toBe('Jane Q Doe');
    expect(displayName('Smith-Jones Ann')).toBe('Ann Smith-Jones');
    expect(form4XmlUrl('0000123456', '0009999999-26-000013', 'xslF345X06/wk-form4_1.xml')).toBe(
      'https://www.sec.gov/Archives/edgar/data/123456/000999999926000013/wk-form4_1.xml',
    );
  });
});

describe('describeFiling (plain English)', () => {
  it.each<[string, string[], string, boolean]>([
    ['8-K', ['2.02', '9.01'], '8-K: results of operations', false],
    ['8-K', ['5.02', '7.01', '9.01'], '8-K: management or board change, Reg FD disclosure', false],
    [
      '8-K',
      ['1.01', '2.03', '8.01', '9.01'],
      '8-K: material agreement, new debt or obligation, other events',
      false,
    ],
    ['8-K', ['3.02'], '8-K: unregistered share sale (possible dilution)', true],
    ['8-K', ['9.01'], '8-K: financial statements and exhibits', false],
    ['8-K/A', ['5.02'], '8-K (amended): management or board change', false],
    ['10-Q', [], '10-Q: quarterly report', false],
    ['S-1', [], 'S-1: registration of new shares (possible dilution)', true],
    ['S-3ASR', [], 'S-3ASR: shelf registration (possible future share or debt issuance)', true],
    [
      '424B5',
      [],
      '424B5: prospectus for an offering (new shares = dilution; often debt/notes for large caps)',
      true,
    ],
    ['4', [], 'Form 4: insider transaction', false],
  ])('%s %j → %s', (form, items, label, dilution) => {
    expect(describeFiling(form, items)).toMatchObject({ label, dilution });
  });
});

describe('summarizeTrades', () => {
  const lot = (
    shares: number,
    price: number | null,
    date: string,
    code: 'P' | 'S' = 'S',
    owner = 'Jane Q Doe',
  ) => ({
    code,
    date,
    shares,
    price,
    value: price === null ? null : shares * price,
    owner,
    role: 'Chief Operating Officer',
    plan10b51: true,
  });

  it('combines many lots per insider and direction into one line with a weighted average', () => {
    const s = summarizeTrades([
      lot(100, 10, '2026-11-12'),
      lot(300, 12, '2026-11-13'),
      lot(50, 9, '2026-11-12', 'P'),
    ]);
    expect(s).toEqual([
      {
        owner: 'Jane Q Doe',
        role: 'Chief Operating Officer',
        code: 'S',
        lots: 2,
        shares: 400,
        avgPrice: 11.5,
        value: 4600,
        firstDate: '2026-11-12',
        lastDate: '2026-11-13',
        plan10b51: true,
      },
      {
        owner: 'Jane Q Doe',
        role: 'Chief Operating Officer',
        code: 'P',
        lots: 1,
        shares: 50,
        avgPrice: 9,
        value: 450,
        firstDate: '2026-11-12',
        lastDate: '2026-11-12',
        plan10b51: true,
      },
    ]);
  });

  it('keeps unpriced lots in the share count but out of the average and value', () => {
    const [s] = summarizeTrades([lot(100, 10, '2026-11-12'), lot(100, null, '2026-11-12')]);
    expect(s).toMatchObject({ shares: 200, avgPrice: 10, value: 1000 });
  });
});
