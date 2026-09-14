/**
 * The single status page (#78).
 *
 * It fetches the three API routes from the browser rather than querying the
 * database directly in a server component. That is the point: the routes are
 * the read surface this slice adds, so the page should exercise them.
 */
'use client';

import { useEffect, useState } from 'react';

interface Coverage {
  ledgerCount: number;
  minLedger: number | null;
  maxLedger: number | null;
  latestClosedAt: string | null;
}

interface Totals {
  paymentCount: number;
  tradeCount: number;
  accountCount: number;
}

interface Asset {
  assetCode: string;
  assetIssuer: string | null;
  transferCount: number;
  totalVolume: number;
  activeDays: number;
}

const num = new Intl.NumberFormat('en-US');
const vol = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** Stellar account ids are 56 characters; show enough to identify, not to wrap. */
function shortIssuer(issuer: string): string {
  return issuer.length <= 12 ? issuer : `${issuer.slice(0, 4)}…${issuer.slice(-4)}`;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return (await response.json()) as T;
}

export default function Page() {
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // All three are independent, so they go out together rather than in series.
    Promise.all([
      getJson<Coverage>('/api/coverage'),
      getJson<Totals>('/api/totals'),
      getJson<{ assets: Asset[] }>('/api/assets'),
    ])
      .then(([c, t, a]) => {
        setCoverage(c);
        setTotals(t);
        setAssets(a.assets);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, []);

  // An empty database has no min/max, so both are null until something is ingested.
  const range =
    coverage && coverage.minLedger !== null && coverage.maxLedger !== null
      ? `${num.format(coverage.minLedger)} – ${num.format(coverage.maxLedger)}`
      : '—';

  return (
    <main className="wrap">
      <header>
        <h1>xlm-flow-indexer</h1>
        <p>Coverage and asset activity, read live from the indexed Stellar ledger data.</p>
      </header>

      {error && (
        <div className="error" style={{ marginTop: 28 }}>
          <strong>Could not load index status.</strong>
          <div style={{ marginTop: 4 }}>{error}</div>
        </div>
      )}

      {!error && (
        <>
          <section className="cards">
            <div className="card">
              <div className="label">Ledgers</div>
              <div className="value">{coverage ? num.format(coverage.ledgerCount) : '…'}</div>
            </div>
            <div className="card">
              <div className="label">Ledger range</div>
              <div className="value small">{coverage ? range : '…'}</div>
            </div>
            <div className="card">
              <div className="label">Payments</div>
              <div className="value">{totals ? num.format(totals.paymentCount) : '…'}</div>
            </div>
            <div className="card">
              <div className="label">Trades</div>
              <div className="value">{totals ? num.format(totals.tradeCount) : '…'}</div>
            </div>
            <div className="card">
              <div className="label">Accounts</div>
              <div className="value">{totals ? num.format(totals.accountCount) : '…'}</div>
            </div>
          </section>

          <h2>Most active assets</h2>
          {assets === null ? (
            <div className="note">Loading…</div>
          ) : assets.length === 0 ? (
            <div className="note">
              No payments indexed yet. Run an ingest against this database to populate it.
            </div>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th>Issuer</th>
                    <th className="num">Transfers</th>
                    <th className="num">Volume</th>
                    <th className="num">Active days</th>
                  </tr>
                </thead>
                <tbody>
                  {assets.map((asset) => (
                    <tr key={`${asset.assetCode}:${asset.assetIssuer ?? ''}`}>
                      <td>{asset.assetCode}</td>
                      <td>
                        {asset.assetIssuer === null ? (
                          <span className="note" style={{ padding: 0 }}>
                            native
                          </span>
                        ) : (
                          <code className="issuer" title={asset.assetIssuer}>
                            {shortIssuer(asset.assetIssuer)}
                          </code>
                        )}
                      </td>
                      <td className="num">{num.format(asset.transferCount)}</td>
                      <td className="num">{vol.format(asset.totalVolume)}</td>
                      <td className="num">{num.format(asset.activeDays)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <footer>
        {coverage?.latestClosedAt
          ? `Latest ledger close: ${coverage.latestClosedAt}`
          : 'Latest ledger close: —'}
      </footer>
    </main>
  );
}
