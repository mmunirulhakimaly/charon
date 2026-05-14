# Charon

Charon is a Telegram trench agent for screening noisy Solana meme-token flow with one built-in strategy: `Ponyin + Narrative`.

# ALERT
This codebase is still in a testing period. The developer does not guarantee any result.

## Flow

1. Charon polls the Charon signal server every `SIGNAL_POLL_MS`.
2. The Ponyin+narrative strategy gates source count, fee requirement, token age, market cap, holders, fees, trend quality, and position caps.
3. Passing candidates are enriched with token info, Jupiter asset/holders/chart data, saved-wallet exposure, and X/Twitter narrative when available.
4. The LLM screens up to `LLM_CANDIDATE_PICK_COUNT` recent candidates and may pick one `BUY`.
5. Narrative strength matters: stronger, stickier, better-supported narratives rank higher.
6. Open positions are monitored every `POSITION_CHECK_MS` for TP, SL, trailing TP, max hold, and partial TP rules.

## Access

Charon requires a signal server URL and API key. The signal server aggregates fee-claim, graduated, and trending data from Pump.fun in real time.

```env
SIGNAL_SERVER_URL=https://api.thecharon.xyz/api
SIGNAL_SERVER_KEY=your_key_here
```

## Install

```bash
git clone git@github.com:yunus-0x/charon.git
cd charon
npm install
cp .env.example .env
npm start
```

For PM2:

```bash
pm2 start index.js --name charon
pm2 save
```

## Required Config

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
SIGNAL_SERVER_URL=https://api.thecharon.xyz/api
SIGNAL_SERVER_KEY=
SIGNAL_POLL_MS=30000
```

RPC endpoint for live execution:

```env
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
SOLANA_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```

If those are not set, Charon falls back to Helius mainnet URLs and requires:

```env
HELIUS_API_KEY=
```

## GMGN Enrichment

```env
GMGN_ENABLED=true
GMGN_API_KEY=
```

GMGN enriches candidates with holder count, liquidity, fee data, and social links. Set `GMGN_ENABLED=false` to skip it.

## LLM Config

```env
ENABLE_LLM=true
LLM_BASE_URL=https://api.minimax.io/v1
LLM_API_KEY=
LLM_MODEL=MiniMax-M2.7
LLM_TIMEOUT_MS=60000
LLM_CANDIDATE_PICK_COUNT=10
LLM_CANDIDATE_MAX_AGE_MS=600000
```

`LLM_BASE_URL` accepts any OpenAI-compatible endpoint. The default is MiniMax M2.7.

Set `ENABLE_LLM=false` to disable LLM globally. The single Ponyin+narrative strategy still keeps its own `use_llm` and `llm_min_confidence` knobs in SQLite for hot changes.

Example:

```bash
/stratset llm_min_confidence 70
```

## Execution Modes

```env
TRADING_MODE=dry_run
```

- `dry_run`: stores simulated buys/sells in SQLite.
- `confirm`: sends a Telegram trade intent with approve/reject buttons.
- `live`: signs and executes Jupiter Ultra swaps immediately after strategy and LLM approval.

Live and confirm modes require:

```env
SOLANA_PRIVATE_KEY=
JUPITER_API_KEY=
JUPITER_SWAP_BASE_URL=https://api.jup.ag/swap/v2
LIVE_MIN_SOL_RESERVE=0.02
```

## Strategy

Use `/menu -> Strategy` or:

```bash
/strategy
/stratset tp_percent 75
/stratset sl_percent -20
/stratset llm_min_confidence 70
```

Current runtime strategy:

- `ponyin_narrative`: immediate entry, fee-aware, narrative-aware, LLM-first screening, partial TP enabled, TP/SL/trailing configurable.

Legacy strategy rows may still exist in SQLite for historical open positions, but all new entries use `ponyin_narrative`.

## Telegram Commands

```bash
/menu
/strategy
/stratset <key> <value>
/positions
/candidate <mint>
/filters
/pnl
/learn <window>
/lessons
/walletadd <label> <address>
/walletremove <label>
/wallets
```

## Storage

Charon uses `charon.sqlite` as source of truth. It stores:

- candidates and filter results
- LLM decisions and batches
- decision logs
- dry-run/live positions and trades
- trade intents
- saved wallets
- strategy config
- learning runs and lessons

Open positions resume monitoring after restart.

## Verification

```bash
npm run check
```

## Config Reloading

SQLite/menu settings are hot-read by the bot. API keys, wallet key, RPC URLs, Jupiter base URL, and polling intervals are `.env` values and require restart.
