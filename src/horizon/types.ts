// Shapes of the Horizon responses Phase 1 consumes. These describe only the fields
// this project reads -- Horizon returns considerably more, and modelling all of it
// would be a maintenance burden with no payoff.
//
// Amounts stay as the strings Horizon sends. Parsing them to numbers here would
// reintroduce exactly the float precision loss ARCHITECTURE.md avoids by storing
// amounts as TEXT.

/** Every paged Horizon resource carries a paging_token used as the next cursor. */
export interface HorizonRecord {
  readonly id: string;
  readonly paging_token: string;
}

export interface HorizonLink {
  readonly href: string;
  readonly templated?: boolean;
}

/** HAL envelope Horizon wraps collections in. */
export interface HorizonPage<T> {
  readonly _links: {
    readonly self?: HorizonLink;
    readonly next?: HorizonLink;
    readonly prev?: HorizonLink;
  };
  readonly _embedded: {
    readonly records: readonly T[];
  };
}

/**
 * A closed ledger.
 *
 * Needed because `operations` and `trades` both reference `ledgers(sequence)`, and an
 * operation record does not carry its ledger's close time or operation count -- only
 * its own `created_at`. The parent rows have to come from somewhere.
 */
export interface HorizonLedger extends HorizonRecord {
  readonly sequence: number;
  readonly closed_at: string;
  readonly operation_count: number;
  readonly successful_transaction_count?: number;
  readonly failed_transaction_count?: number;
}

export interface HorizonOperation extends HorizonRecord {
  readonly type: string;
  readonly type_i: number;
  readonly source_account: string;
  readonly created_at: string;
  readonly transaction_successful?: boolean;
  readonly transaction_hash?: string;

  // Present on payment and path payment operations.
  readonly from?: string;
  readonly to?: string;
  readonly amount?: string;
  readonly asset_type?: string;
  readonly asset_code?: string;
  readonly asset_issuer?: string;

  // Path payments additionally describe what the sender spent.
  readonly source_amount?: string;
  readonly source_asset_type?: string;
  readonly source_asset_code?: string;
  readonly source_asset_issuer?: string;
}

export interface HorizonEffect extends HorizonRecord {
  readonly type: string;
  readonly type_i: number;
  readonly account: string;
  readonly created_at: string;

  // Present on trustline effects.
  readonly asset_type?: string;
  readonly asset_code?: string;
  readonly asset_issuer?: string;
  readonly limit?: string;
}

export interface HorizonTrade extends HorizonRecord {
  readonly ledger_close_time: string;

  /**
   * 'orderbook' or 'liquidity_pool'. Optional because Horizon added it in v2; a
   * response without it predates liquidity pools, so order-book is the only thing it
   * could describe.
   */
  readonly trade_type?: string;

  readonly base_amount: string;
  readonly base_asset_type: string;
  readonly base_asset_code?: string;
  readonly base_asset_issuer?: string;
  readonly counter_amount: string;
  readonly counter_asset_type: string;
  readonly counter_asset_code?: string;
  readonly counter_asset_issuer?: string;

  // Exactly one side of a trade is an account or a pool, never both. Either side may
  // be the pool in a liquidity_pool trade -- both shapes occur on testnet -- so
  // neither pool id can be assumed absent.
  readonly base_account?: string;
  readonly counter_account?: string;
  readonly base_liquidity_pool_id?: string;
  readonly counter_liquidity_pool_id?: string;
  readonly liquidity_pool_fee_bp?: number;
}

/**
 * Query parameters common to Horizon's paged collections.
 *
 * `cursor` is a paging_token. Passing one resumes from that point, which is what
 * makes an interrupted ingestion restartable.
 */
// `| undefined` is explicit rather than incidental. These params are spread into a
// Record that already permits undefined values, and under exactOptionalPropertyTypes
// a bare `cursor?: string` would reject `{ ...params, cursor }` where cursor is not
// yet known -- which is exactly the shape the first page of a paginate() call has.
export interface PagingParams {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  readonly order?: 'asc' | 'desc' | undefined;
}
