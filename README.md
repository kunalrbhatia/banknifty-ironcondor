# BANKNIFTY Monthly 45-DTE Delta-Hedged Short Strangle (Iron Condor)

An algorithmic options trading engine built on Node.js, TypeScript, and Angel One SmartAPI. It executes a systematic, carryforward, single-position defined-risk iron condor (short strangle + wings) on monthly BANKNIFTY index options, entering at ~45 DTE and exiting at 50% profit, 100% stop-loss, or 15 DTE.

---

## Strategy Overview

- **Instrument:** BANKNIFTY monthly index options (`NFO`).
- **Structure:** Defined-risk 4-leg iron condor:
  - Short 1 lot ~30-delta CE + Short 1 lot ~30-delta PE (Premium collection)
  - Long 1 lot ~15-17 delta CE + Long 1 lot ~15-17 delta PE (Protective wings capping tail risk)
  - Sized for Risk:Reward ≈ 1:2.
- **Style:** Carryforward (multi-day / multi-week hold), strictly 1 active position at a time (no scaling or averaging).
- **Entry Schedule:** Evaluated once daily at **15:00 IST** (15:00–15:15 IST window):
  1. Checks `data/banknifty-position.json` for an open position (if open, defers to monitoring/exit logic).
  2. Resolves current BANKNIFTY monthly expiry dynamically from Angel One scrip master.
  3. Computes calendar-day DTE from today to monthly expiry.
  4. If `DTE` is within window (`45 ± 3`), anchors entry to the nearest **previous trading day** and executes.
- **Delta Calculation (Black-Scholes Inversion):**
  - Live option chain pulled for all strikes.
  - Implied volatility backed out via Newton-Raphson on live LTPs.
  - Delta computed per strike/side. Strikes chosen independently to match ~30Δ for shorts and ~16Δ for hedges (preferring further-OTM on equidistant deltas).
- **Phased Order Execution:**
  - **Phase 1 (Hedges first):** Long CE + Long PE buy orders placed and confirmed. If either fails, the other is immediately unwound and entry aborted.
  - **Phase 2 (Shorts second):** Short CE + Short PE sell orders placed together. If partial/failure occurs, all filled short legs AND both hedge legs are unwound immediately.
- **Exit Triggers:**
  - **Stop Loss (SL):** Unrealized loss reaches **100%** of net entry credit received.
  - **Profit Target (PT):** Unrealized profit reaches **50%** of net entry credit received.
  - **15-DTE Hard Exit:** Forced square-off at **15:00 IST** when 15 calendar days remain to expiry (holiday-adjusted backwards to previous trading day if 15-DTE falls on a holiday or weekend).
- **Risk & Monitoring:** Continuous WebSocket MTM evaluation during market hours, logged to append-only files at `logs/mtm/mtm-BANKNIFTY-{YYYY-MM-DD}.log`.

---

## Core Engineering Principles

Built according to production safety rules established in `blueprint-banknifty.md`:

1. **Non-Destructive Cleanup (§2.1):** Position state preservation — closed positions maintain historical pricing, P&L, and exit metadata for reports and audits.
2. **Degrade, Don't Guess (§2.2):** Risk-critical calculations alert loudly if live quotes or margins fail to load; never silently fallback.
3. **Independent Control Switches (§1.6, §2.3):**
   - Soft Pause (`.kill-banknifty`): Pauses new entries; leaves active position exits and monitoring untouched.
   - Hard Stop (`.panic-banknifty`): Immediate emergency square-off and total halt.
   - Paper Mode (`.paper`): Simulates execution and ticks without routing orders to broker.
4. **Non-Idempotent Order Guard (§2.4):** Order placement calls are strictly excluded from generic auto-retry to prevent duplicate orders.
5. **Timezone Determinism (§2.5):** All date, calendar, and DTE calculations use `Intl.DateTimeFormat` with `Asia/Kolkata` and explicit `Date.UTC(...)` arithmetic. Process manager pins `TZ=UTC`.
6. **Append-Only Reporting (§2.6, §1.8):** Daily trade reports at 15:40 IST are generated directly from the immutable intraday MTM log, not from mutable live position memory.
7. **Scrip Master Lot Size Verification (§2.10):** Aggregates contract rows via majority voting; blocks trading and alerts if scrip master diverges from configured lot size.

---

## Project Structure

```text
banknifty-ironcondor/
├── .agents/                     # Agent rules and automation skills
│   ├── rules/
│   │   └── pr-rules.md
│   └── skills/
│       ├── gh-pr-workflow/
│       ├── git-cleanup-sync/
│       ├── pr-description-check/
│       ├── readme-auto-update/
│       └── verify-pr-status/
├── .github/
│   ├── CODEOWNERS
│   └── workflows/
│       ├── ci.yml               # GitHub Actions CI workflow
│       └── deploy.yml           # Continuous deployment to Oracle Cloud
├── analysis/
│   ├── generateReport.ts        # 15:40 IST daily trade report generator
│   └── reports/                 # Output markdown trade reports (gitignored)
├── logs/
│   └── mtm/                     # Append-only tick logs: mtm-BANKNIFTY-{YYYY-MM-DD}.log
├── src/
│   ├── config/
│   │   └── env.ts               # Typed Zod environment schema
│   ├── helpers/
│   │   ├── api.ts               # Resilient Axios client with retry control
│   │   ├── blackScholes.ts      # Black-Scholes pricing, delta, and IV inversion
│   │   ├── constants.ts         # Endpoints and index configurations
│   │   ├── holidayCheck.ts      # Calendar DTE & trading day adjustments
│   │   ├── logger.ts            # Winston logger with daily rotation & IST timestamps
│   │   ├── login.ts             # SmartAPI TOTP login & session management
│   │   ├── marketData.ts        # Spot and batch LTP fetchers
│   │   ├── modeManager.ts       # File-based switches (.kill-banknifty, .panic-banknifty, .paper)
│   │   ├── mtmLogger.ts         # Append-only MTM log formatter
│   │   ├── orders.ts            # Angel One order placement wrapper
│   │   ├── scripMaster.ts       # Scrip master caching & majority-vote lot verification
│   │   └── websocket.ts         # 4-leg WebSocket feed & real-time monitoring
│   ├── jobs/
│   │   ├── dailyEntryJob.ts     # 15:00 IST entry & 15-DTE check runner
│   │   └── exitMonitor.ts       # SL / PT / 15-DTE / Panic exit evaluator
│   ├── store/
│   │   └── positionStore.ts     # Dedicated BANKNIFTY JSON position store
│   ├── telegram/
│   │   └── bot.ts               # Owner-authenticated command bot (/status, /kill, /panic)
│   ├── main.ts                  # Engine bootstrap & cron orchestration
│   ├── notifier.ts              # Telegram & Slack alerting dispatcher
│   └── server.ts                # Express health check server
├── tests/
│   ├── fixtures/
│   │   └── fixture-mtm-banknifty.log
│   └── strategy.test.ts         # Complete test suite
├── blueprint-banknifty.md       # Strategy specifications
├── package.json
└── tsconfig.json
```

---

## Setup & Running

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Environment Variables

Copy `.env.example` to `.env` and fill in credentials:

```bash
cp .env.example .env
```

### 3. Build & Test

```bash
pnpm run format:check
pnpm run lint
pnpm run test
pnpm run build
pnpm run smoke-report
```
