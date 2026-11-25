import { BPS, runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, Hello, BuyInput, OrderInput } from './vendor/makefun-bars.ts';

const LOOKBACK_BARS = 24;
const REBALANCE_BARS = 12;
const TOP_N = 3;
const DRAWDOWN_BPS_LIMIT = 2000n; // 20%
const MIN_NOTIONAL_QUOTE = 1000000n; // 1 USDC (6 decimals)

interface State {
  history: Map<string, (bigint | null)[]>;
  maxEquity: bigint;
  pendingBuySymbols: string[] | null;
  lastRebalanceBar: number;
}

export async function main() {
  const stateData: State = {
    history: new Map(),
    maxEquity: 0n,
    pendingBuySymbols: null,
    lastRebalanceBar: -999,
  };

  await runBars({
    onHello: (state: BarsState) => {
      for (const s of state.hello.symbols) {
        stateData.history.set(s.symbol, []);
      }
    },
    onBatch: (state: BarsState, batch: Batch): OrderInput[] | undefined => {
      if (state.warmingUp) {
        return undefined;
      }

      const currentBar = state.seq;

      for (const [symbol, bar] of state.latest.entries()) {
        let hist = stateData.history.get(symbol);
        if (!hist) {
          hist = [];
          stateData.history.set(symbol, hist);
        }
        hist.push(BigInt(bar.c));
      }

      if (state.equity > stateData.maxEquity) {
        stateData.maxEquity = state.equity;
      }

      const orders: OrderInput[] = [];

      if (stateData.pendingBuySymbols !== null) {
        const symbolsToBuy = stateData.pendingBuySymbols;
        stateData.pendingBuySymbols = null;

        for (const sym of symbolsToBuy) {
          const room = state.weightRoom(sym);
          if (room < MIN_NOTIONAL_QUOTE) {
            continue;
          }
          if (state.cash < room) {
            if (state.cash < MIN_NOTIONAL_QUOTE) {
              break;
            }
            orders.push({
              side: 'buy',
              symbol: sym,
              notional_quote_units: state.cash,
              max_slippage_bps: 10000,
            });
            break;
          } else {
            orders.push({
              side: 'buy',
              symbol: sym,
              notional_quote_units: room,
              max_slippage_bps: 10000,
            });
          }
        }
        return orders.length > 0 ? orders : undefined;
      }

      let inDrawdown = false;
      if (stateData.maxEquity > 0n) {
        const dd = ((stateData.maxEquity - state.equity) * 10000n) / stateData.maxEquity;
        if (dd >= DRAWDOWN_BPS_LIMIT) {
          inDrawdown = true;
        }
      }

      const hasPositions = state.positions.size > 0;

      if (inDrawdown) {
        if (hasPositions) {
          for (const [sym, pos] of state.positions.entries()) {
            orders.push({
              side: 'sell',
              symbol: sym,
              qty: pos.qty,
              max_slippage_bps: 10000,
            });
          }
          stateData.pendingBuySymbols = null;
          return orders;
        }
        return undefined;
      }

      const barsSinceRebalance = currentBar - stateData.lastRebalanceBar;
      if (barsSinceRebalance < REBALANCE_BARS && hasPositions) {
        return undefined;
      }

      let minHistoryLength = Infinity;
      for (const hist of stateData.history.values()) {
        if (hist.length < minHistoryLength) {
          minHistoryLength = hist.length;
        }
      }

      if (minHistoryLength < LOOKBACK_BARS + 1) {
        return undefined;
      }

      const momentums: { symbol: string; mom: bigint }[] = [];
      let totalMom = 0n;
      let countMom = 0n;

      for (const [sym, hist] of stateData.history.entries()) {
        const currentClose = hist[hist.length - 1];
        const pastClose = hist[hist.length - 1 - LOOKBACK_BARS];
        if (currentClose !== null && pastClose !== null && pastClose > 0n) {
          const mom = ((currentClose - pastClose) * 10000n) / pastClose;
          momentums.push({ symbol: sym, mom });
          totalMom += mom;
          countMom += 1n;
        }
      }

      if (countMom === 0n) {
        return undefined;
      }

      const avgMom = totalMom / countMom;

      momentums.sort((a, b) => {
        if (b.mom > a.mom) return 1;
        if (b.mom < a.mom) return -1;
        return 0;
      });

      const topSymbols: string[] = [];
      if (avgMom > 0n) {
        for (let i = 0; i < momentums.length && topSymbols.length < TOP_N; i++) {
          if (momentums[i].mom > 0n) {
            topSymbols.push(momentums[i].symbol);
          }
        }
      }

      const currentHeld = Array.from(state.positions.keys());
      const needSell = currentHeld.some((sym) => !topSymbols.includes(sym));
      const needBuy = topSymbols.some((sym) => !state.positions.has(sym));

      if (!needSell && !needBuy && currentHeld.length === topSymbols.length) {
        stateData.lastRebalanceBar = currentBar;
        return undefined;
      }

      stateData.lastRebalanceBar = currentBar;

      if (hasPositions) {
        for (const [sym, pos] of state.positions.entries()) {
          if (!topSymbols.includes(sym)) {
            orders.push({
              side: 'sell',
              symbol: sym,
              qty: pos.qty,
              max_slippage_bps: 10000,
            });
          }
        }
      }

      const symbolsToAcquire = topSymbols.filter((sym) => !state.positions.has(sym));

      if (orders.length > 0) {
        if (symbolsToAcquire.length > 0) {
          stateData.pendingBuySymbols = symbolsToAcquire;
        }
        return orders;
      }

      if (symbolsToAcquire.length > 0) {
        for (const sym of symbolsToAcquire) {
          const room = state.weightRoom(sym);
          if (room < MIN_NOTIONAL_QUOTE) {
            continue;
          }
          if (state.cash < room) {
            if (state.cash < MIN_NOTIONAL_QUOTE) {
              break;
            }
            orders.push({
              side: 'buy',
              symbol: sym,
              notional_quote_units: state.cash,
              max_slippage_bps: 10000,
            });
            break;
          } else {
            orders.push({
              side: 'buy',
              symbol: sym,
              notional_quote_units: room,
              max_slippage_bps: 10000,
            });
          }
        }
      }

      return orders.length > 0 ? orders : undefined;
    },
  });
}

await main();
