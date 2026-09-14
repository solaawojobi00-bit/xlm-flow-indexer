/**
 * The index readout (#78).
 *
 * Three in-page sections behind client-side tabs rather than routes: the whole
 * thing is one fetch of three endpoints, and giving the assets table its own
 * screen is the only reason it needs to be more than one view.
 *
 * It fetches the API routes from the browser rather than querying in a server
 * component on purpose — those routes are the read surface this slice adds, so
 * the page should exercise them.
 */
'use client';

import { useEffect, useMemo, useState } from 'react';

const REPO = 'https://github.com/solaawojobi00-bit/xlm-flow-indexer';

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

type Tab = 'overview' | 'assets' | 'about';
type SortKey = 'transferCount' | 'totalVolume' | 'activeDays';

const count = new Intl.NumberFormat('en-US');
const volume = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const exact = new Intl.NumberFormat('en-US', { maximumFractionDigits: 7 });

/** Stellar account ids are 56 characters. Show enough to tell two apart. */
function shortIssuer(issuer: string): string {
  return issuer.length <= 14 ? issuer : `${issuer.slice(0, 6)}…${issuer.slice(-6)}`;
}

function utcClock(iso: string): string {
  return `${iso.slice(11, 19)} UTC`;
}

function utcStamp(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return (await response.json()) as T;
}

export default function Page() {
  const [tab, setTab] = useState<Tab>('overview');
  const [coverage, setCoverage] = useState<Coverage | null>(null);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({
    key: 'totalVolume',
    desc: true,
  });

  // Sections are tabs rather than routes, but a readout is the kind of page
  // people link to a specific part of, so the choice is mirrored into the hash.
  useEffect(() => {
    const fromHash = window.location.hash.slice(1);
    if (fromHash === 'assets' || fromHash === 'about') setTab(fromHash);
  }, []);

  useEffect(() => {
    // Independent endpoints, so they go out together rather than in series.
    Promise.all([
      getJson<Coverage>('/api/coverage'),
      getJson<Totals>('/api/totals'),
      getJson<{ assets: Asset[] }>('/api/assets'),
    ])
      .then(([c, t, a]) => {
        setCoverage(c);
        setTotals(t);
        setAssets(a.assets);
        setFetchedAt(new Date().toISOString());
      })
      .catch(() => setFailed(true));
  }, []);

  const sorted = useMemo(() => {
    if (!assets) return null;
    const rows = [...assets];
    rows.sort((a, b) => {
      const delta = a[sort.key] - b[sort.key];
      // Asset code breaks ties so equal values never reorder between renders.
      return (sort.desc ? -delta : delta) || a.assetCode.localeCompare(b.assetCode);
    });
    return rows;
  }, [assets, sort]);

  // Narrowed once into a concrete object: an empty database reports null bounds,
  // and every consumer below wants both or neither.
  const win =
    coverage && coverage.minLedger !== null && coverage.maxLedger !== null
      ? { min: coverage.minLedger, max: coverage.maxLedger }
      : null;
  const spanLabel = coverage ? `${count.format(coverage.ledgerCount)} ledgers` : 'reading…';

  function toggleSort(key: SortKey) {
    setSort((prev) => (prev.key === key ? { key, desc: !prev.desc } : { key, desc: true }));
  }

  function sortHeader(key: SortKey, label: string) {
    const active = sort.key === key;
    return (
      <button
        type="button"
        className="sort"
        data-active={active}
        onClick={() => toggleSort(key)}
        aria-label={`Sort by ${label}`}
      >
        {label}
        <span className="sort-caret" aria-hidden="true">
          {active ? (sort.desc ? '↓' : '↑') : ' '}
        </span>
      </button>
    );
  }

  return (
    <div className="shell">
      <header className="masthead">
        <h1 className="wordmark">
          xlm<span className="slash">/</span>flow<span className="slash">/</span>indexer
        </h1>
        <nav className="tabs" role="tablist" aria-label="Sections">
          {(
            [
              ['overview', 'Overview'],
              ['assets', 'Assets'],
              ['about', 'About'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              className="tab"
              aria-selected={tab === id}
              onClick={() => {
                setTab(id);
                history.replaceState(null, '', id === 'overview' ? './' : `#${id}`);
              }}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      {failed && (
        <div className="notice" role="alert">
          <p>
            <strong>Can&rsquo;t reach the index.</strong> The database didn&rsquo;t answer, so
            there are no figures to show.
          </p>
          <p>Reload to try again. If it keeps failing, the indexer instance is likely down.</p>
        </div>
      )}

      {/* ── Overview ──────────────────────────────────────────────────── */}
      {tab === 'overview' && !failed && (
        <section className="panel" aria-label="Overview">
          <p className="kicker">Stellar testnet · indexed window</p>
          <h2 className="lede">
            A contiguous run of {spanLabel}, pulled from Horizon and queryable as SQL.
          </h2>

          <div className="rail">
            <div className="rail-figures">
              <span className="rail-bound">{win ? count.format(win.min) : '—'}</span>
              <span className="rail-span">{spanLabel}</span>
              <span className="rail-bound">{win ? count.format(win.max) : '—'}</span>
            </div>

            <div className="rail-track" aria-hidden="true">
              <span className="rail-beyond" />
              <span className="rail-window">
                <span className={`rail-fill${coverage ? ' is-charged' : ''}`} />
              </span>
              <span className="rail-beyond" />
            </div>

            <div className="rail-legend">
              <span>earlier, not indexed</span>
              <span>later, not indexed</span>
            </div>
          </div>

          <div className="readouts">
            <div className="readout">
              <div className={`readout-value${totals ? '' : ' is-waiting'}`}>
                {totals ? count.format(totals.paymentCount) : '——'}
              </div>
              <div className="readout-label">payments</div>
            </div>
            <div className="readout">
              <div className={`readout-value${totals ? '' : ' is-waiting'}`}>
                {totals ? count.format(totals.tradeCount) : '——'}
              </div>
              <div className="readout-label">trades</div>
            </div>
            <div className="readout">
              <div className={`readout-value${totals ? '' : ' is-waiting'}`}>
                {totals ? count.format(totals.accountCount) : '——'}
              </div>
              <div className="readout-label">accounts seen</div>
            </div>
          </div>

          <div className="provenance">
            <div className="status">
              <span
                className={`status-dot${failed ? ' is-down' : fetchedAt ? '' : ' is-waiting'}`}
                aria-hidden="true"
              />
              <span>
                {fetchedAt ? `Read from the database at ${utcClock(fetchedAt)}` : 'Reading…'}
              </span>
            </div>
            <p>
              Data comes from{' '}
              <span className="hi">
                Stellar testnet
                {win ? `, ledgers ${count.format(win.min)}–${count.format(win.max)}` : ''}
              </span>
              , ingested through Horizon and stored in Postgres.
            </p>
            <p>
              These figures are queried fresh every time the page loads, but the ledger range
              itself is a one-time backfill and is not advancing.{' '}
              {coverage?.latestClosedAt
                ? `The last ledger in it closed ${utcStamp(coverage.latestClosedAt)}.`
                : ''}
            </p>
          </div>
        </section>
      )}

      {/* ── Assets ────────────────────────────────────────────────────── */}
      {tab === 'assets' && !failed && (
        <section className="panel" aria-label="Assets">
          <h2 className="section-title">Assets moved in this window</h2>
          <p className="kicker">Ranked by volume. Up to 20 shown.</p>

          {sorted === null ? (
            <p className="empty">Reading from the index…</p>
          ) : sorted.length === 0 ? (
            <p className="empty">
              No payments landed in this ledger range, so there is nothing to rank yet.
            </p>
          ) : (
            <>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>
                        <span className="th-static">Asset</span>
                      </th>
                      <th>
                        <span className="th-static">Issuer</span>
                      </th>
                      <th className="num">{sortHeader('transferCount', 'Transfers')}</th>
                      <th className="num">{sortHeader('totalVolume', 'Volume')}</th>
                      <th className="num">{sortHeader('activeDays', 'Active days')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((asset) => (
                      <tr key={`${asset.assetCode}:${asset.assetIssuer ?? ''}`}>
                        <td className="asset-code">{asset.assetCode}</td>
                        <td>
                          {asset.assetIssuer === null ? (
                            // XLM's asset_code is literally 'native', so repeating
                            // the word here would say nothing. The point is that it
                            // has no issuer at all.
                            <span className="native-tag" title="Native asset — XLM has no issuer">
                              no issuer
                            </span>
                          ) : (
                            <span className="issuer" title={asset.assetIssuer}>
                              {shortIssuer(asset.assetIssuer)}
                            </span>
                          )}
                        </td>
                        <td className="num">{count.format(asset.transferCount)}</td>
                        <td className="num" title={exact.format(asset.totalVolume)}>
                          {volume.format(asset.totalVolume)}
                        </td>
                        <td className="num is-flat">{count.format(asset.activeDays)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <dl className="table-notes">
                <div>
                  <dt>Volume</dt>
                  <dd>
                    Total amount of the asset moved by payments in this window, in the asset&rsquo;s
                    own units. Amounts are not converted to a common currency, so volumes are
                    comparable within a row, not across them. Hover a figure for full precision.
                  </dd>
                </div>
                <div>
                  <dt>Active days</dt>
                  <dd>
                    Distinct UTC days on which the asset moved. Every row reads 1 here, because the
                    indexed window spans about 17 minutes and so falls inside a single day. It
                    becomes a useful measure once the backfill covers more than one day.
                  </dd>
                </div>
                <div>
                  <dt>Issuer</dt>
                  <dd>
                    A Stellar asset is identified by code <em>and</em> issuer, so the same ticker
                    from two issuers is two different assets and is listed separately. Hover an
                    issuer for the full account id.
                  </dd>
                </div>
              </dl>
            </>
          )}
        </section>
      )}

      {/* ── About ─────────────────────────────────────────────────────── */}
      {tab === 'about' && (
        <section className="panel" aria-label="About">
          <h2 className="section-title">What you&rsquo;re looking at</h2>
          <div className="prose">
            <p>
              Horizon, the standard Stellar API, is built for operational lookups — fetch this
              account, submit that transaction. It is not built to answer questions that span
              history, like how much moved through one asset issuer last month.
            </p>
            <p>
              xlm-flow-indexer reads ledger data from Horizon and writes it into a relational
              schema shaped for exactly those questions, so they become ordinary SQL. This page is
              a readout for one running instance of it.
            </p>

            <dl>
              <dt>Where the numbers come from</dt>
              <dd>
                Three read-only queries against the indexer&rsquo;s Postgres database, run when you
                loaded this page. Nothing is cached or precomputed.
              </dd>

              <dt>Why the window is small</dt>
              <dd>
                Ingestion runs at roughly 50 ledgers a minute against Horizon, so the full testnet
                history would take about two months to pull. This instance holds a bounded recent
                slice, enough to show the pipeline works end to end.
              </dd>

              <dt>Source</dt>
              <dd>
                <a href={REPO} rel="noreferrer">
                  github.com/solaawojobi00-bit/xlm-flow-indexer
                </a>
              </dd>
            </dl>
          </div>
        </section>
      )}

      <footer className="foot">
        <span>Stellar testnet · read-only</span>
        <span>
          <a href={REPO} rel="noreferrer">
            Source on GitHub
          </a>
        </span>
      </footer>
    </div>
  );
}
