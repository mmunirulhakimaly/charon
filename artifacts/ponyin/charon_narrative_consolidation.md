# Charon Narrative Consolidation

## What Changed

The main LLM screening prompt in `src/pipeline/llm.js` now explicitly treats **narrative quality** as a ranking factor for trench tokens.

It now asks the model to:

- classify narrative type as one of:
  - `cult_culture`
  - `news`
  - `politics`
  - `animal`
  - `ai_tech`
  - `viral_social_article`
  - `charity`
  - `big_figure_person`
  - `unclear`
- score narrative strength from `0-20`
- explain why the narrative is strong or weak
- heavily penalize tokens whose only narrative evidence is an **X/Twitter status/quote link** with weak or missing text and no broader community proof

## Prompt Inputs Used

The LLM now receives a tighter `narrative` block built from the existing candidate object:

- `token.name`
- `token.symbol`
- `token.twitter`
- `token.website`
- `token.telegram`
- `token.gmgnUrl`
- `twitterNarrative.url`
- `twitterNarrative.text`
- `twitterNarrative.metrics`
- `twitterNarrative.virality`
- `metrics.marketCapUsd`
- `metrics.liquidityUsd`
- `metrics.holderCount`
- `metrics.trendingVolumeUsd`
- `metrics.trendingSwaps`
- `metrics.trendingSmartDegenCount`
- `trending`
- `graduation`
- `holders`
- `savedWalletExposure`
- `chart.distanceFromAthPercent`
- `chart.topBlastRisk`

It also receives social presence flags:

- `hasWebsite`
- `hasTelegram`
- `hasTwitterProfile`
- `hasStatusLink`
- `hasNarrativeText`
- `onlyXQuoteLinkRisk`

## Repo Logic Mapping

### Narrative-sensitive but LLM-driven

- `src/pipeline/llm.js`
  - ranks candidates
  - now classifies narrative type and strength
  - now penalizes weak quote-link-only setups

### Hard filters before LLM

- `src/pipeline/candidateBuilder.js`
  - fee claim gate
  - market-cap range
  - GMGN total fee gate
  - graduated volume gate
  - holder count gate
  - top-holder concentration
  - saved-wallet holder overlap
  - ATH distance guard
  - trending filters
  - wash-trading rejection

Narrative **does not** bypass these gates.

### Strategy config that still controls final behavior

From SQLite strategy config seeded in `src/db/connection.js`:

- `min_source_count`
- `require_fee_claim`
- `token_age_max_ms`
- `min_mcap_usd`
- `max_mcap_usd`
- `min_fee_claim_sol`
- `min_gmgn_total_fee_sol`
- `min_holders`
- `max_top20_holder_percent`
- `min_saved_wallet_holders`
- `max_ath_distance_pct`
- `trending_min_volume_usd`
- `trending_min_swaps`
- `trending_max_rug_ratio`
- `trending_max_bundler_rate`
- `position_size_sol`
- `max_open_positions`
- `tp_percent`
- `sl_percent`
- `trailing_enabled`
- `trailing_percent`
- `partial_tp`
- `partial_tp_at_percent`
- `partial_tp_sell_percent`
- `max_hold_ms`
- `use_llm`
- `llm_min_confidence`

### Environment/config knobs

From `.env.example` and `src/config.js`:

- `ENABLE_LLM`
- `LLM_BASE_URL`
- `LLM_API_KEY`
- `LLM_MODEL`
- `LLM_TIMEOUT_MS`
- `LLM_CANDIDATE_PICK_COUNT`
- `LLM_CANDIDATE_MAX_AGE_MS`
- `GMGN_ENABLED`
- `GMGN_API_KEY`
- `GMGN_REQUEST_DELAY_MS`
- `GMGN_MAX_RETRIES`
- `TRENDING_ENABLED`
- `TRENDING_SOURCE`
- `TRENDING_ALLOW_DEGEN`
- `TRENDING_INTERVAL`
- `TRENDING_LIMIT`
- `TRENDING_ORDER_BY`
- `TRENDING_MIN_VOLUME_USD`
- `TRENDING_MIN_SWAPS`
- `TRENDING_MAX_RUG_RATIO`
- `TRENDING_MAX_BUNDLER_RATE`

## Narrative Interpretation Rules

### Strong narrative signals

- easy to retell in one sentence
- category fits the token name/symbol cleanly
- social text matches the token identity
- broader proof exists beyond a single quoted X post
- timing is still fresh enough for the category
- not already obviously blown out near the top

### Weak / dangerous narrative signals

- generic ticker pretending to be AI, politics, animal, or celebrity
- only a single X quote/status link and no real text/community context
- no website and no Telegram
- social text unrelated to the coin branding
- narrative is stale while top-blast risk is already high
- famous-person attachment with no organic spread proof

## Output Shape Added

The LLM output schema now includes:

- `narrative_type`
- `narrative_score`
- `narrative_notes`

These are stored in existing `raw_json` flow without a DB migration.

## Remaining Gaps

Still missing from codebase:

- revoke authority / mint authority checks
- explicit DEX paid / ads / boost timing ingestion
- wallet clustering beyond simple concentration fields
- direct Telegram surfacing of `narrative_score` and `narrative_type`
- quote-link detection stronger than current heuristic flags
