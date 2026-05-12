import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { db } from '../db/connection.js';
import { boolSetting, numSetting } from '../db/settings.js';
import { json, now, safeJson, strictJsonFromText } from '../utils.js';

const REVIEW_VERDICTS = new Set(['HOLD_MOONBAG', 'CLOSE_MOONBAG', 'TIGHTEN_TRAIL']);

export function normalizeMoonbagReview(parsed, fallbackReason = '') {
  const verdict = REVIEW_VERDICTS.has(String(parsed?.verdict).toUpperCase())
    ? String(parsed.verdict).toUpperCase()
    : 'HOLD_MOONBAG';
  const rawTrail = parsed?.new_trailing_percent;
  const newTrailingPercent = rawTrail == null || rawTrail === '' ? null : Number(rawTrail);
  return {
    verdict,
    confidence: Math.max(0, Math.min(100, Number(parsed?.confidence) || 0)),
    reason: String(parsed?.reason || fallbackReason || 'Moonbag review complete.').slice(0, 500),
    risks: Array.isArray(parsed?.risks) ? parsed.risks.map(String).slice(0, 8) : [],
    new_trailing_percent: Number.isFinite(newTrailingPercent) && newTrailingPercent > 0 ? newTrailingPercent : null,
    raw: parsed,
  };
}

function latestReview(positionId) {
  return db.prepare(`
    SELECT *
    FROM position_reviews
    WHERE position_id = ?
    ORDER BY created_at_ms DESC
    LIMIT 1
  `).get(positionId);
}

function storeReview(positionId, review) {
  db.prepare(`
    INSERT INTO position_reviews (position_id, created_at_ms, verdict, confidence, reason, risks_json, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    positionId,
    now(),
    review.verdict,
    review.confidence,
    review.reason,
    json(review.risks || []),
    json(review.raw ?? review),
  );
}

function compactSnapshot(position) {
  const snapshot = safeJson(position.snapshot_json, {});
  const candidate = snapshot?.candidate || {};
  return {
    token: candidate.token || { mint: position.mint, symbol: position.symbol },
    signals: candidate.signals || null,
    metrics: candidate.metrics || null,
    feeClaim: candidate.feeClaim || null,
    trending: candidate.trending || null,
    holders: candidate.holders || null,
    chart: candidate.chart || null,
    savedWalletExposure: candidate.savedWalletExposure || null,
    entryDecision: snapshot?.decision || null,
    entryReason: snapshot?.reason || null,
  };
}

export function moonbagReviewEligibility(position, context = {}) {
  const strat = context.strategy || context.strat;
  if (position.status !== 'open') return { ok: false, reason: 'position_not_open' };
  if (Number(position.partial_tp_done || 0) !== 1) return { ok: false, reason: 'partial_tp_not_done' };
  if (!strat?.partial_tp) return { ok: false, reason: 'strategy_partial_tp_disabled' };
  if (!boolSetting('moonbag_llm_review_enabled', false)) return { ok: false, reason: 'setting_disabled' };
  if (!ENABLE_LLM || !LLM_API_KEY) return { ok: false, reason: 'llm_disabled_or_missing_key' };

  const intervalMs = Math.max(60_000, numSetting('moonbag_llm_review_interval_ms', 5 * 60 * 1000));
  const previous = latestReview(position.id);
  if (previous && now() - Number(previous.created_at_ms) < intervalMs) {
    return { ok: false, reason: 'rate_limited', previous };
  }
  return { ok: true, previous };
}

export async function reviewMoonbagPosition(position, context = {}) {
  const eligibility = moonbagReviewEligibility(position, context);
  if (!eligibility.ok) return { skipped: true, skipReason: eligibility.reason, previous: eligibility.previous || null };

  const strat = context.strategy || context.strat;
  const currentTrailing = Number(position.trailing_percent || 0);
  const system = [
    'You are Charon, a Solana meme coin position risk reviewer.',
    'Return strict JSON only. Do not include markdown, prose, or explanations outside JSON.',
    'You are reviewing ONLY the remaining moonbag after a partial take-profit has already happened.',
    'The initial risk has been reduced by partial TP; your job is to manage the residual runner, not the full original position.',
    'Prefer HOLD_MOONBAG unless current context shows clear downside, thesis failure, or a need to protect profits.',
    'Use CLOSE_MOONBAG only when the leftover moonbag should be fully exited.',
    'Use TIGHTEN_TRAIL when upside remains possible but the remaining moonbag needs a tighter trailing stop.',
    'Confidence is conviction from 0 to 100, not probability.',
  ].join(' ');

  const user = {
    task: 'Review the open position moonbag after partial TP and choose how to manage only the remaining position.',
    output_schema: {
      verdict: 'HOLD_MOONBAG|CLOSE_MOONBAG|TIGHTEN_TRAIL',
      confidence: 'number 0-100',
      reason: 'short string',
      risks: ['short strings'],
      new_trailing_percent: 'optional positive number or null; only for TIGHTEN_TRAIL',
    },
    guardrails: {
      only_remaining_moonbag: true,
      partial_tp_done: true,
      live_close_requires_high_confidence: true,
      current_trailing_percent: currentTrailing,
    },
    position: {
      id: position.id,
      mint: position.mint,
      symbol: position.symbol,
      execution_mode: position.execution_mode || 'dry_run',
      opened_at_ms: position.opened_at_ms,
      size_sol: position.size_sol,
      entry_price: position.entry_price,
      entry_mcap: position.entry_mcap,
      high_water_price: context.highWaterPrice ?? position.high_water_price,
      high_water_mcap: context.highWaterMcap ?? position.high_water_mcap,
      current_price: context.price ?? null,
      current_mcap: context.mcap ?? null,
      pnl_percent: context.pnlPercent ?? position.pnl_percent ?? null,
      pnl_sol: context.pnlSol ?? position.pnl_sol ?? null,
      tp_percent: position.tp_percent,
      sl_percent: position.sl_percent,
      trailing_enabled: Boolean(position.trailing_enabled),
      trailing_percent: currentTrailing,
      trailing_armed: Boolean(context.trailingArmed ?? position.trailing_armed),
      partial_tp_done: Boolean(position.partial_tp_done),
      strategy_id: position.strategy_id,
      strategy: strat,
    },
    market: {
      asset: context.asset || null,
      jupiterPnl: context.jupiterPnl || null,
    },
    entry_snapshot: compactSnapshot(position),
  };

  try {
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.1,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: JSON.stringify(user) },
      ],
    }, {
      timeout: LLM_TIMEOUT_MS,
      headers: { authorization: `Bearer ${LLM_API_KEY}`, 'content-type': 'application/json' },
    });
    const content = res.data?.choices?.[0]?.message?.content || '';
    const parsed = strictJsonFromText(content);
    const review = normalizeMoonbagReview(parsed);
    review.raw = { parsed, content, usage: res.data?.usage || null };
    storeReview(position.id, review);
    return review;
  } catch (err) {
    console.log(`[position-reviewer] ${position.id} failed: ${err.message}`);
    const review = normalizeMoonbagReview({
      verdict: 'HOLD_MOONBAG',
      confidence: 0,
      reason: `Moonbag review failed: ${err.message}`,
      risks: ['llm_review_error'],
      new_trailing_percent: null,
      error: err.message,
    });
    storeReview(position.id, review);
    return review;
  }
}
