/**
 * Horizon paging tokens for ledger-scoped resources are TOIDs: a 64-bit value laying
 * out ledger sequence in the high 32 bits, then transaction and operation index.
 *
 * That layout is what makes a ledger range addressable. Horizon has no
 * `?from_ledger=&to_ledger=` filter on /operations, so the only way to ask for a range
 * is to start from a cursor just below the range and stop reading once records pass
 * its end. Both halves of that are here so no caller has to open-code the bit shifts.
 */

const LEDGER_SHIFT = 32n;

/**
 * Ledger sequence a paging token belongs to.
 *
 * Two token shapes exist and both appear in Phase 1. Operations, trades and ledgers
 * use a bare TOID (`19498507278745600`). Effects append an index to disambiguate the
 * several effects a single operation can produce (`19498507278749697-1`), because the
 * TOID alone is not unique for them. Parsing the bare form only would throw on every
 * effect token, which is what the trustlines job reads.
 */
export function ledgerOf(pagingToken: string): number {
  const toid = pagingToken.split('-')[0];
  if (toid === undefined || toid === '' || !/^\d+$/.test(toid)) {
    throw new RangeError(`Unrecognised Horizon paging token: ${pagingToken}`);
  }
  return Number(BigInt(toid) >> LEDGER_SHIFT);
}

/**
 * A cursor positioned immediately before the first record of `ledger`.
 *
 * Horizon treats `cursor` as exclusive, so this is the last possible token of the
 * preceding ledger: passing it returns the first record of `ledger` itself.
 */
export function cursorBeforeLedger(ledger: number): string {
  if (!Number.isInteger(ledger) || ledger < 1) {
    throw new RangeError(`Ledger sequence must be a positive integer, got ${String(ledger)}`);
  }
  return ((BigInt(ledger) << LEDGER_SHIFT) - 1n).toString();
}
