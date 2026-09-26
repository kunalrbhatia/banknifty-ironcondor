# Algo Trading Strategy Blueprint — BANKNIFTY 45-DTE Short Strangle (Hedged, Delta-Based)

_This is a standalone strategy: its own position store, its own MTM log, its own daily job, its own kill switches. Section 1 documents the trading logic. Section 2 documents strategy-agnostic engineering principles the implementation must follow._

---

## 1. Current Strategy — BANKNIFTY Monthly 45-DTE Delta-Hedged Short Strangle

### Overview

- **Instrument:** BANKNIFTY monthly options only.
- **Style:** Carryforward (multi-day/multi-week hold), single position at a time, no scaling/averaging.
- **Structure:** Defined-risk short strangle — sell 1 lot ~30-delta CE + 1 lot ~30-delta PE, and buy 1 lot ~15-17-delta CE + 1 lot ~15-17-delta PE as protective hedges (4 legs total: 2 short, 2 long, same expiry). This is effectively an iron condor (short strangle with wings), sized so max loss ≈ half of max reward (**Risk:Reward 1:2**).
- **Runs independently of the NIFTY straddle** (`blueprint.md`): separate position file (`data/banknifty-position.json` or equivalent), separate MTM log directory, separate daily job — never share state, kill switches, or reporting between the two.
- **Schedule:** One job, once a day, in the **15:00–15:15 IST** window, every trading day:
  1. Check the BANKNIFTY position store for an open position. If one exists → skip entry, defer to monitoring/exit logic for that position.
  2. If no open position → resolve the current BANKNIFTY monthly expiry and compute its DTE.
  3. If DTE => 40 and DTE <=50 (see rounding/holiday note below) → run the entry sequence within the 15:00–15:15 window and place all 4 legs.
- **Expiry resolution:** Always the **monthly** BANKNIFTY expiry (resolve dynamically from the scrip master, never hardcode the expiry weekday). DTE is calculated in **calendar days** from "today" to that expiry date.
- **One trade per cycle:** Only one strangle+hedge structure is ever open at a time. After an exit (SL, PT, or 15-DTE), no re-entry into the same expiry — the next entry is evaluated against the _next_ monthly expiry's 45-DTE date.

### Position structure (4 legs)

| Leg             | Expiry                                   | Side | Qty                                                                       | Target delta                | Role                    |
| --------------- | ---------------------------------------- | ---- | ------------------------------------------------------------------------- | --------------------------- | ----------------------- |
| Short CE        | Current monthly                          | SELL | 1 lot (`LOT_SIZE`, env-configurable — verify against scrip master, §2.10) | ~30Δ (nearest available)    | Premium collection      |
| Short PE        | Current monthly                          | SELL | 1 lot                                                                     | ~30Δ (nearest available)    | Premium collection      |
| Long CE (hedge) | Current monthly, same expiry as short CE | BUY  | 1 lot                                                                     | ~15–17Δ (nearest available) | Caps upside tail risk   |
| Long PE (hedge) | Current monthly, same expiry as short PE | BUY  | 1 lot                                                                     | ~15–17Δ (nearest available) | Caps downside tail risk |

All 4 legs share the same expiry (the current 45-DTE monthly). Call-side and put-side strikes are selected **independently** — the short call's delta and short put's delta are each matched to ~30Δ on their own side (they will generally land on different strikes since call/put IV skew differs), and likewise for each hedge leg on its own side.

### Delta calculation — Black-Scholes

<!-- No live delta feed from Angel One SmartAPI — delta is computed in-process via Black-Scholes off each strike's live LTP-implied IV. -->

1. For the current expiry, pull the live option chain (LTP for every CE/PE strike) and the current spot LTP.
2. For each strike/side, back out **implied volatility** from the live LTP via Black-Scholes inversion (Newton-Raphson or bisection on the BS price formula), using time-to-expiry in years (`T = DTE / 365`), risk-free rate (`RISK_FREE_RATE`, env-configurable, e.g. 0.065), and dividend yield = 0 (index options).
3. Compute BS delta for each strike/side from that implied IV.
4. **Short leg selection:** on each side (CE, PE) independently, scan strikes and pick the one whose `abs(delta)` is closest to `SHORT_TARGET_DELTA` (default 0.30). Ties broken by preferring the strike with the smaller `abs(delta - target)`; if two strikes are equidistant, prefer the further-OTM strike (safer, matches "nearest, then more conservative" convention).
5. **Hedge leg selection:** on each side independently, pick the strike whose `abs(delta)` is closest to the midpoint of `HEDGE_TARGET_DELTA_MIN`/`HEDGE_TARGET_DELTA_MAX` (default 0.15–0.17 → target 0.16), same nearest-match / further-OTM tie-break as above. The hedge strike must be **further OTM than the corresponding short strike** on the same side (sanity check — reject and alert if the nearest-delta hedge strike would land inside the short strike, which would invert the spread).

```javascript
// Black-Scholes price (for IV inversion) and delta
function bsPrice(spot, strike, T, r, sigma, isCall) {
  const d1 = (Math.log(spot / strike) + (r + sigma ** 2 / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const N = normCdf;
  return isCall
    ? spot * N(d1) - strike * Math.exp(-r * T) * N(d2)
    : strike * Math.exp(-r * T) * N(-d2) - spot * N(-d1);
}

function bsDelta(spot, strike, T, r, sigma, isCall) {
  const d1 = (Math.log(spot / strike) + (r + sigma ** 2 / 2) * T) / (sigma * Math.sqrt(T));
  return isCall ? normCdf(d1) : normCdf(d1) - 1;
}

// Newton-Raphson IV inversion from observed market price
function impliedVol(marketPrice, spot, strike, T, r, isCall, guess = 0.25) {
  let sigma = guess;
  for (let i = 0; i < 50; i++) {
    const price = bsPrice(spot, strike, T, r, sigma, isCall);
    const vega = spot * normPdf(d1(spot, strike, T, r, sigma)) * Math.sqrt(T);
    if (Math.abs(vega) < 1e-8) break;
    const diff = price - marketPrice;
    if (Math.abs(diff) < 1e-4) break;
    sigma -= diff / vega;
    sigma = Math.max(0.01, Math.min(sigma, 5)); // clamp to sane bounds
  }
  return sigma;
}
// normCdf / normPdf / d1: standard implementations — verify against a known reference
// (e.g. a known BS price/delta pair) in a unit test before relying on this in production (§2.10-style verification discipline).
```

**Nearest-strike selection:**

```javascript
function pickNearestDeltaStrike(chainSide, targetDelta) {
  // chainSide: array of { strike, delta } for one side (CE or PE), already BS-computed
  return chainSide.reduce((best, row) => {
    const diff = Math.abs(Math.abs(row.delta) - targetDelta);
    const bestDiff = Math.abs(Math.abs(best.delta) - targetDelta);
    if (diff < bestDiff) return row;
    if (diff === bestDiff) return row.strike > best.strike ? row : best; // prefer further-OTM on tie (placeholder convention — confirm)
    return best;
  });
}
```

### Entry sequence (strict order)

#### Step 1 — Position & DTE check (15:00 IST daily)

- Trading-day check (holiday calendar — resolve via exchange trading-day calendar/API, never a hardcoded list; verify on every run rather than caching indefinitely).
- Read the BANKNIFTY position store. If an open position exists, skip to monitoring and end this job run.
- If no open position: fetch current monthly BANKNIFTY expiry from the scrip master, compute calendar-day DTE.
- If `DTE !== 45`, log and exit — normal no-op path most days.

#### Step 2 — Delta scan (only on a confirmed 45-DTE day, within 15:00–15:15 IST)

- Fetch full option chain LTPs (CE + PE, all strikes) and spot LTP for BANKNIFTY.
- Run Black-Scholes IV inversion + delta calc per strike/side.
- Select: short CE strike (~30Δ), short PE strike (~30Δ), long CE hedge strike (~15–17Δ, further OTM than short CE), long PE hedge strike (~15–17Δ, further OTM than short PE).
- Sanity-check Risk:Reward: max loss (width of each wing minus net credit, per side, whichever is larger) should be roughly 2× the net credit received. Log the actual ratio; alert (non-blocking, informational) if it deviates materially from ~1:2 — strike granularity means it won't be exact.

#### Step 3 — Order placement (all 4 legs)

- **Order the hedge (long) legs first, confirm fills, then the short legs** — deliberately, because buying protection before selling naked premium avoids ever holding uncovered short risk mid-entry if the job is interrupted. This is the one place entry legs are _not_ placed simultaneously — all other legs within a phase are placed together.
  1. Buy long CE hedge + long PE hedge together.
  2. Confirm both hedge fills.
  3. Sell short CE + short PE together.
  4. Confirm both short fills.
- If Step 3.1/3.2 (hedges) fail to fill within the retry budget, abort entirely — do not proceed to selling naked shorts. Alert loudly.
- See §1.2 below for partial-fill handling once hedges are confirmed and shorts are being placed.

#### Step 4 — Post-entry snapshot

- On confirmed 4-leg fill, record: entry timestamp, all 4 strikes + sides, all 4 entry premiums, **net credit received** (Rs = `((shortCE_LTP + shortPE_LTP) - (longCE_LTP + longPE_LTP)) * LOT_SIZE`), and derive:
  - `slAmount` = net credit received (Rs) — i.e. 100% of credit.
  - `ptAmount` = 50% of net credit received (Rs).
  - `dte15Date` = expiry date − 15 calendar days (trading-day adjusted, see §1.3.1).
- Start/confirm the WebSocket MTM monitoring loop for all 4 legs (§1.7).

### §1.1 Defined-risk structure (confirmed)

This structure is **defined-risk**: the long hedge legs cap max loss. Max loss per side ≈ (wing width − net credit received). This does not remove the need for kill-switch/margin discipline (§1.6) — SPAN margin still applies and can move intraday on volatility spikes — but the tail risk is bounded by construction, unlike an unhedged naked short position. Margin alerting for this strategy can be tuned to a lower severity threshold than would be appropriate for an undefined-risk (naked) structure, but must still follow the "degrade, don't guess" principle (§2.2): never silently continue past a stale or fallback margin/price figure.

### §1.2 Partial-entry policy

- The position is only "open" once all 4 legs are confirmed filled, in the order given in Step 3.
- **Hedge legs (Step 3.1):** if only one of the two hedge legs fills, retry the missing one (bounded budget, dedicated to entry completion, excluded from generic idempotent retry per §2.4). If it still fails, **exit the filled hedge leg** and abort the day's entry — do not proceed to selling shorts with an incomplete hedge. Alert loudly.
- **Short legs (Step 3.2):** hedges are already fully filled and confirmed at this point, so a partial short fill is safer than a partial hedge fill (no naked exposure is created), but still not the intended 4-leg state. If only one short leg fills, retry the missing one (bounded budget). If it still fails within the budget, **exit the filled short leg and both hedge legs** — unwind the entire attempted structure rather than carry an unintended 3-leg position — and alert loudly that the day's entry aborted.
- A partially-filled-then-unwound day does not count as a trade for that expiry. Re-attempt the next trading day while DTE is still within a reasonable freshness window (env-configurable, e.g. `DTE >= 43`), otherwise skip that expiry cycle and wait for the next month.

### §1.3 Exit rules — 50% credit profit target / 100% credit stop-loss / 15-DTE hard exit

Exit is evaluated on **net credit in ₹** across all 4 legs, not on margin percentage.

#### Baseline (entry net credit)

- Captured once, at confirmed 4-leg fill (Step 4 above): `entryCreditRupees = ((shortCE_LTP + shortPE_LTP) - (longCE_LTP + longPE_LTP)) * LOT_SIZE`.
- Immutable for the life of the position — never recomputed from a mutable store field after entry (§2.1). Persist it in the position snapshot at entry time.

#### Thresholds

```
slAmount  = entryCreditRupees            // 100% of credit received — full loss of credit collected
ptAmount  = entryCreditRupees * 0.5      // 50% of credit received
```

| Condition                                                                       | Action                                                                            |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `unrealizedLossRupees >= slAmount`                                              | Exit all 4 legs immediately (market/limit-with-fallback per §2.4) — stop-loss hit |
| `unrealizedProfitRupees >= ptAmount`                                            | Exit all 4 legs immediately — profit target hit                                   |
| Neither triggered by 15 DTE (or nearest prior trading day, §1.3.1) at 15:00 IST | Exit all 4 legs at whatever P&L stands — time-based exit                          |

**Worked example:** if net credit received at entry = ₹8,000 → SL = ₹8,000 loss, PT = ₹4,000 profit.

#### P&L calculation

- `currentNetCreditRupees = ((shortCE_currentLTP + shortPE_currentLTP) - (longCE_currentLTP + longPE_currentLTP)) * LOT_SIZE`
- `unrealizedPnLRupees = entryCreditRupees - currentNetCreditRupees`
  - Positive = profit (net position has decayed/moved in our favor since we are net short premium).
  - Negative = loss (net credit required to close has risen above what we received).
- Computed continuously off live WebSocket LTP for all 4 legs (§1.7) — never off stale/cached LTP.
- A "worthless leg" concept can legitimately apply here on the **hedge legs** specifically (a far-OTM long hedge can decay to near-zero) — but since P&L is computed on the _net_ 4-leg formula above, no special-case exclusion logic is needed; the formula marks correctly regardless of any individual leg's LTP.

#### Exit execution (SL / PT / 15-DTE)

- On any of the three trigger conditions, exit **all 4 legs together** — buy-to-cover both shorts, sell-to-close both hedges — as a single unwind operation (not phased like entry; unwind order does not carry the same risk asymmetry entry does, since by the time we're exiting, either the position is intact or SL/PT has already fired on the position we have).
- Use limit-with-fallback order logic (§2.4-safe).
- On confirmed exit fills: record exit timestamp, exit LTPs for all 4 legs, realized P&L, exit reason (`SL` / `PT` / `15DTE`), and close the position in the store.
- Send an immediate alert (Telegram primary, Slack fallback) with the exit reason and realized P&L.

#### Carryforward & monitoring sessions

- Position is held carryforward across all trading days between entry and exit.
- Monitoring runs continuously via WebSocket during market hours every day the position is open (§1.7); SL/PT can trigger intraday, any day.
- The 15:00–15:15 daily job still runs every day regardless — for an open position, it only performs the 15-DTE check; for no position, it evaluates 45-DTE entry.

#### §1.3.1 15-DTE hard exit (with holiday adjustment)

- Target hard-exit date = expiry date − 15 calendar days.
- If that date is a market holiday, exit on the **previous trading day** (e.g. 15 DTE falls on a holiday → exit on 14 DTE), never the next trading day.
- Exit executes at **15:00 IST** on that (adjusted) day, using whatever unrealized P&L stands at that time, unless SL or PT has already triggered intraday before then.

| Position status at 15:00 IST on 15-DTE (or adjusted) day | Action                                                            |
| -------------------------------------------------------- | ----------------------------------------------------------------- |
| Still open (neither SL nor PT triggered)                 | Exit all 4 legs at market/limit-with-fallback, log reason `15DTE` |
| Already closed earlier (SL or PT already triggered)      | No-op — position already closed                                   |

#### §1.3.2 Scheduled job times (IST)

| Time                      | Job                                                  | Details                                                                                                   |
| ------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 15:00–15:15               | Daily entry/DTE-check job                            | No open position → check 45-DTE entry (hedges first, then shorts); open position → check 15-DTE hard exit |
| Continuous (market hours) | WebSocket MTM monitor                                | Evaluates SL/PT on every tick across all 4 legs while a position is open (§1.7)                           |
| 15:40                     | Daily report (if a trade closed or is open that day) | Reads from `logs/mtm/banknifty-*.log` append-only log                                                     |

### §1.4 Instrument scope

- **Current scope:** BANKNIFTY monthly options only, one 4-leg position at a time.
- Lot size verified dynamically against the scrip master by majority vote across matching contract rows before any entry — never hardcoded and never taken from a single/last row (§2.10).

### §1.5 Scheduling

- **15:00–15:15 IST daily:** entry/DTE-check job (§1.3.2). Hedges before shorts on entry days (Step 3).
- **Continuous during market hours while a position is open:** WebSocket MTM monitor evaluating SL (100% of credit) / PT (50% of credit) across the net 4-leg position.
- **15:40 IST:** daily report generation, if applicable.

### §1.6 Kill switch, reporting, margin

- Dedicated `.kill-banknifty` / `.panic-banknifty` switches (or equivalent strategy-scoped mechanism), independent of any other strategy's switches that may exist in this codebase. `.kill-banknifty` pauses new entries (the 45-DTE check) without touching the live SL/PT/15-DTE monitor on an open position; `.panic-banknifty` force-exits all 4 legs immediately regardless of P&L.
- Because this is a **defined-risk** structure (§1.1), margin/tail-risk alerting can be lower-severity than for an undefined-risk strategy, but margin-call alerts should still follow the "degrade, don't guess" principle (§2.2) — never silently continue on a stale/fallback margin figure.
- Trade reporting is sourced from the append-only MTM log (§1.7), never from live mutable position state (§2.1, §2.6).

### §1.7 MTM log (WebSocket → file)

#### File naming & location

- `logs/mtm/mtm-BANKNIFTY-{YYYY-MM-DD}.log`, one file per trading day, append-only, rotated daily.

#### Line format (exact)

```
{ISO8601 IST timestamp} | BANKNIFTY | shortCE={strike}@{ltp} | shortPE={strike}@{ltp} | longCE={strike}@{ltp} | longPE={strike}@{ltp} | netCredit={netCredit} | unrealizedPnL={unrealizedPnL} | pctOfSL={pctOfSL} | pctOfPT={pctOfPT}
```

| Field           | Rule                                                                   |
| --------------- | ---------------------------------------------------------------------- |
| `netCredit`     | `((shortCE_LTP + shortPE_LTP) - (longCE_LTP + longPE_LTP)) * LOT_SIZE` |
| `unrealizedPnL` | `entryCreditRupees - netCredit`                                        |
| `pctOfSL`       | `max(0, -unrealizedPnL) / slAmount * 100`                              |
| `pctOfPT`       | `max(0, unrealizedPnL) / ptAmount * 100`                               |

#### When to write

- Fixed cadence (e.g. every 60s) while a position is open and market is live, **plus** immediately on any SL/PT breach.
- No writes when no position is open — omit rather than log zeros.

#### Implementation notes

- Timestamps always IST regardless of process `TZ` (§2.5) — explicit `Asia/Kolkata`, never server-local time.
- Append-only — never rewritten or truncated intraday.

```javascript
function formatMtmLogLine(date, legs, entryCreditRupees, lotSize, slAmount, ptAmount) {
  // legs = { shortCE, shortPE, longCE, longPE }, each { strike, ltp }
  const netCredit =
    (legs.shortCE.ltp + legs.shortPE.ltp - (legs.longCE.ltp + legs.longPE.ltp)) * lotSize;
  const unrealizedPnL = entryCreditRupees - netCredit;
  const pctOfSL = (Math.max(0, -unrealizedPnL) / slAmount) * 100;
  const pctOfPT = (Math.max(0, unrealizedPnL) / ptAmount) * 100;
  const ts = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(date);
  return `${ts} | BANKNIFTY | shortCE=${legs.shortCE.strike}@${legs.shortCE.ltp} | shortPE=${legs.shortPE.strike}@${legs.shortPE.ltp} | longCE=${legs.longCE.strike}@${legs.longCE.ltp} | longPE=${legs.longPE.strike}@${legs.longPE.ltp} | netCredit=${netCredit} | unrealizedPnL=${unrealizedPnL} | pctOfSL=${pctOfSL.toFixed(1)} | pctOfPT=${pctOfPT.toFixed(1)}`;
}
```

### §1.8 Daily trade report (15:40 IST — from MTM log)

- Report reads from `logs/mtm/mtm-BANKNIFTY-{date}.log` (append-only), never from live mutable position state.
- **Input (required):** the day's MTM log file. If missing (no position was open that day), skip report generation.
- **Input (supplementary, static only):** entry snapshot (4 strikes, entry deltas at selection time, entry credit, SL/PT amounts, DTE at entry) — header context only, never used for P&L math (that comes from the MTM log).
- **Report content (minimum):** all 4 leg entry details, latest net credit, unrealized/realized P&L, % of SL and PT consumed, exit reason if closed that day, DTE remaining to expiry and to the 15-DTE hard-exit date.
- **Output:** `analysis/reports/{YYYY-MM-DD}-banknifty-strangle.md`.
- **Scheduling:** runs at 15:40 IST, after the day's entry/exit job and after market close. A CI smoke test should render this report against a fixture MTM log (§2.9), including a fixture with all 4 legs present.

---

## 2. Core Engineering Principles

These apply to the implementation of this strategy regardless of which specific trading logic §1 describes:

- **§2.1 State/cleanup separation:** the position store holds only what's needed to resume monitoring/exit logic (strikes, entry credit, SL/PT amounts, timestamps). Never recompute an immutable entry-time value (e.g. entry credit) from a later mutable field — capture it once at entry and persist it.
- **§2.2 Degrade, don't guess:** if a required live value (margin, LTP, delta) can't be fetched, alert and pause the relevant action rather than substituting a stale/fallback/assumed value and proceeding silently.
- **§2.3 Kill switches:** file-based `.kill-banknifty` (pause new entries only) and `.panic-banknifty` (force-exit open position immediately) switches, checked at the start of every relevant job run.
- **§2.4 Idempotent retries, bounded:** reads (LTP, chain, margin) can be retried with a generic bounded-retry wrapper. Order placement/entry-completion and exits use their own dedicated, more conservative retry budgets — never blindly retry an order placement with the same generic logic used for read calls, to avoid duplicate fills.
- **§2.5 Timezone discipline:** every timestamp used for scheduling or logging is computed in `Asia/Kolkata` explicitly (e.g. via `Intl.DateTimeFormat`), never relying on the host/process's local timezone or `TZ` env var.
- **§2.6 Reporting from logs, not live state:** the daily report is generated from the append-only MTM log file, never from the live/mutable position store, so a report is reproducible and immune to any in-memory state bugs.
- **§2.7 Alerting channels:** Telegram primary, Slack fallback, for all entry/exit/error/partial-fill events.
- **§2.8 Report visibility:** decide explicitly (public/private/gitignored) whether `analysis/reports/` is committed — don't leave this as an accidental default.
- **§2.9 CI smoke tests:** report generation should be tested against a fixture MTM log file in CI, not only manually.
- **§2.10 Lot-size verification:** before any entry, the lot size used must be reconciled against the scrip master by majority vote across matching contract rows for BANKNIFTY specifically — never hardcoded, never assumed from another instrument, never taken from a single/last row.

## 3. Environment variables (strategy-specific)

```
# Strategy-specific toggles (BANKNIFTY 45-DTE Delta-Hedged Short Strangle — §1)
LOT_SIZE=                        # BANKNIFTY lot size — always reconcile against scrip master, block entry on mismatch (§2.10)
TARGET_DTE=45                    # §1: DTE at which entry is evaluated daily
HARD_EXIT_DTE=15                 # §1.3.1: latest DTE to force-close if SL/PT not hit (holiday-adjusted to nearest prior trading day)
SHORT_TARGET_DELTA=0.30          # §1: target |delta| for short CE/PE
HEDGE_TARGET_DELTA_MIN=0.15      # §1: lower bound of hedge target delta band
HEDGE_TARGET_DELTA_MAX=0.17      # §1: upper bound of hedge target delta band
PT_PCT_OF_CREDIT=50              # §1.3: profit target as % of entry net credit
SL_PCT_OF_CREDIT=100             # §1.3: stop-loss as % of entry net credit (full credit given back)
RISK_FREE_RATE=0.065             # §1: used in Black-Scholes IV inversion / delta calc
ENTRY_WINDOW_START_HOUR=15       # §1.3.2: entry window start (IST)
ENTRY_WINDOW_START_MINUTE=0
ENTRY_WINDOW_END_HOUR=15         # §1.3.2: entry window end (IST)
ENTRY_WINDOW_END_MINUTE=15
REPORT_HOUR=15                   # §1.8: IST time for post-close markdown report
REPORT_MINUTE=40
```
