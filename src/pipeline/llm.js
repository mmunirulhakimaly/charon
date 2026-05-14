import axios from 'axios';
import { ENABLE_LLM, LLM_API_KEY, LLM_BASE_URL, LLM_MODEL, LLM_TIMEOUT_MS } from '../config.js';
import { now, stripThinking, strictJsonFromText } from '../utils.js';
import { activeStrategy, numSetting } from '../db/settings.js';
import { db } from '../db/connection.js';

export function normalizeDecision(parsed, fallbackReason = '') {
  const verdict = ['BUY', 'WATCH', 'PASS'].includes(String(parsed?.verdict).toUpperCase())
    ? String(parsed.verdict).toUpperCase()
    : 'WATCH';
  return {
    verdict,
    confidence: Math.max(0, Math.min(100, Number(parsed?.confidence) || 0)),
    reason: String(parsed?.reason || fallbackReason).slice(0, 1000),
    risks: Array.isArray(parsed?.risks) ? parsed.risks.map(String).slice(0, 8) : [],
    suggested_tp_percent: Number(parsed?.suggested_tp_percent) || numSetting('default_tp_percent', 50),
    suggested_sl_percent: Number(parsed?.suggested_sl_percent) || numSetting('default_sl_percent', -25),
    narrative_type: String(parsed?.narrative_type || 'unclear').slice(0, 64),
    narrative_score: Math.max(0, Math.min(20, Number(parsed?.narrative_score) || 0)),
    narrative_notes: String(parsed?.narrative_notes || '').slice(0, 500),
    raw: parsed,
  };
}

export function activeLessonsForPrompt(limit = 6) {
  return db.prepare(`
    SELECT lesson
    FROM learning_lessons
    WHERE status = 'active'
    ORDER BY id DESC
    LIMIT ?
  `).all(limit).map(row => row.lesson);
}

export function compactCandidateForLlm(row) {
  const c = row.candidate;
  const athWindow = c.chart?.windows?.find(window => window.label === 'ath_context_24h_5m' && window.available)
    || c.chart?.windows?.find(window => window.label === 'recent_24h_5m' && window.available);
  const token = c.token || {};
  const twitterNarrative = c.twitterNarrative || null;
  const twitterUrl = String(twitterNarrative?.url || token.twitter || '');
  const hasStatusLink = /(?:^|\/)status\/\d+/i.test(twitterUrl);
  const hasWebsite = Boolean(token.website);
  const hasTelegram = Boolean(token.telegram);
  const hasTwitterProfile = Boolean(token.twitter) && !hasStatusLink;
  const hasNarrativeText = Boolean(twitterNarrative?.text && twitterNarrative.text.trim());
  const socialLinks = {
    website: token.website || '',
    telegram: token.telegram || '',
    twitter: token.twitter || '',
    gmgn: token.gmgnUrl || '',
  };
  const onlyXQuoteLinkRisk = hasStatusLink && !hasNarrativeText && !hasWebsite && !hasTelegram && !hasTwitterProfile;
  return {
    candidate_id: row.id,
    mint: c.token?.mint,
    route: c.signals?.route,
    signals: c.signals,
    token: c.token,
    metrics: c.metrics,
    feeClaim: c.feeClaim,
    trending: c.trending,
    graduation: c.graduation,
    holders: c.holders,
    chart: {
      purpose: 'ATH/range context only. Do not treat large 24h change as bullish/bearish momentum by itself.',
      currentNative: c.chart?.currentNative,
      rangeHighNative: c.chart?.rangeHighNative,
      distanceFromAthPercent: c.chart?.distanceFromAthPercent ?? c.chart?.belowRangeHighPercent,
      topBlastRisk: c.chart?.topBlastRisk,
      athContext24h: athWindow ? {
        current: athWindow.current,
        high: athWindow.high,
        low: athWindow.low,
        distanceFromHighPercent: athWindow.belowHighPercent,
        aboveLowPercent: athWindow.aboveLowPercent,
      } : null,
      windows: c.chart?.windows,
    },
    savedWalletExposure: c.savedWalletExposure,
    twitterNarrative,
    narrative: {
      socialLinks,
      socialPresence: {
        hasWebsite,
        hasTelegram,
        hasTwitterProfile,
        hasStatusLink,
        hasNarrativeText,
        onlyXQuoteLinkRisk,
      },
      heuristics: {
        candidateKeywords: narrativeKeywordHints(token, twitterNarrative),
        narrativeTextPreview: String(twitterNarrative?.text || '').slice(0, 280),
      },
    },
    filters: c.filters,
  };
}

function narrativeKeywordHints(token = {}, twitterNarrative = null) {
  const text = [
    token.name,
    token.symbol,
    token.twitter,
    token.website,
    token.telegram,
    twitterNarrative?.text,
  ].filter(Boolean).join(' ').toLowerCase();
  const hints = [];
  const push = (label, patterns) => {
    if (patterns.some(pattern => pattern.test(text))) hints.push(label);
  };
  push('cult_culture', [/\bcult\b/, /\bculture\b/, /\bmeme\b/, /\blore\b/, /\bcommunity\b/, /\bwojak\b/, /\bmog\b/, /\bpepe\b/, /\btroll\b/, /\bspx\b/]);
  push('news', [/\bbreaking\b/, /\bheadline\b/, /\bnews\b/, /\bviral story\b/, /\bdrama\b/, /\brescue\b/, /\btraged/i]);
  push('politics', [/\btrump\b/, /\bboden\b/, /\bwhitehouse\b/, /\belection\b/, /\bpresident\b/, /\bpolitic/i, /\bmaga\b/]);
  push('animal', [/\bdog\b/, /\bcat\b/, /\bhippo\b/, /\bsquirrel\b/, /\bfrog\b/, /\bpepe\b/, /\bpopcat\b/, /\bmoodeng\b/, /\banimal\b/]);
  push('ai_tech', [/\bai\b/, /\bagent\b/, /\bgpt\b/, /\bclaude\b/, /\btech\b/, /\bterminal\b/, /\bbot\b/, /\bcode\b/, /\bllm\b/]);
  push('viral_social_article', [/\bviral\b/, /\btiktok\b/, /\binstagram\b/, /\barticle\b/, /\bx\.com\b/, /\btwitter\b/, /\byoutube\b/, /\bchallenge\b/]);
  push('charity', [/\bcharity\b/, /\bdonation\b/, /\bdonate\b/, /\bcause\b/, /\brescue\b/, /\bhelp\b/, /\bfund\b/]);
  push('big_figure_person', [/\bcelebrity\b/, /\binfluencer\b/, /\brapper\b/, /\bathlete\b/, /\bkanye\b/, /\byzy\b/, /\bmother\b/, /\bpersona\b/]);
  return hints;
}

export async function decideCandidateBatch(rows, triggerCandidateId) {
  if (!ENABLE_LLM || !LLM_API_KEY) {
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: 'LLM disabled or LLM_API_KEY missing.',
      risks: ['no_llm_decision'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: null,
    };
  }

  const strat = activeStrategy();
  const system = [
    'You are Charon, a Solana meme coin trench analyst.',
    'Return strict JSON only.',
    'You will receive up to 10 recently matched candidates.',
    'Pick at most one candidate to buy through the configured execution mode.',
    'Use verdict BUY only for the single best unusually strong asymmetric opportunity.',
    'If partial_tp is active, judge whether the candidate is worthy of holding the remaining moonbag after the partial take-profit.',
    'BUY only candidates with asymmetric upside; candidates that only fit a quick scalp must be WATCH or PASS.',
    'Do not suggest a take-profit below entry_policy.tp_percent.',
    'Use WATCH if candidates are interesting but none deserves a buy.',
    'Use PASS if the set is weak or unsafe.',
    'Narrative quality matters. Stronger, stickier, easier-to-retell narratives deserve better ranking among otherwise eligible candidates.',
    'You must classify the main narrative as one of: cult_culture, news, politics, animal, ai_tech, viral_social_article, charity, big_figure_person, unclear.',
    'Narrative strength is scored from 0 to 20.',
    '0-3 = no clear meme or narrative; 4-7 = weak or generic; 8-11 = clear but only moderate proof; 12-15 = strong and well-supported; 16-20 = exceptional trench narrative with sticky spread and credible social proof.',
    'A strong narrative improves ranking but never overrides safety guardrails like wash trading, rug signals, bundler concentration, weak liquidity, or late entry.',
    'Treat tokens whose only evidence is an X/Twitter status or quote link, with weak or missing text and no broader social/community proof, as a red flag. Penalize heavily and usually avoid BUY.',
    'Generic AI, politics, animal, or celebrity naming with shallow proof should score low even if the category is popular.',
    'Cult/culture narratives should score highest only when they feel sticky, memetic, repeatable, and community-driven rather than just random ticker cosplay.',
    'News and politics narratives are fast and can be strong, but they decay quickly; punish stale or already-peaked narrative timing.',
    'Big figure person coins should be treated cautiously because fanbase-driven pumps often dump hard unless there is broader proof of organic spread.',
    'Chart data is ATH/range context. Do not penalize or reward a token only because 24h change is huge; new Pump tokens often do that.',
    'Use distance from ATH/range high and top-blast risk to decide whether entry is late.',
    'Confidence is your conviction from 0 to 100, not probability.',
  ].join(' ');
  const user = {
    task: 'Pick the best dry-run buy candidate from this recent batch, or choose none.',
    recent_lessons: activeLessonsForPrompt(),
    entry_policy: {
      strategy_id: strat.id,
      strategy_name: strat.name,
      tp_percent: strat.tp_percent,
      sl_percent: strat.sl_percent,
      trailing_enabled: strat.trailing_enabled,
      trailing_percent: strat.trailing_percent,
      partial_tp: strat.partial_tp,
      partial_tp_at_percent: strat.partial_tp_at_percent,
      partial_tp_sell_percent: strat.partial_tp_sell_percent,
      max_hold_ms: strat.max_hold_ms,
      thesis: 'Single Ponyin+narrative strategy. Prefer tokens with strong memetic or event-driven narrative plus clean trench quality and safer structure.',
    },
    output_schema: {
      verdict: 'BUY|WATCH|PASS',
      selected_candidate_id: 'integer candidate_id when verdict is BUY, otherwise null',
      selected_mint: 'mint string when verdict is BUY, otherwise null',
      confidence: 'number 0-100',
      reason: 'short string',
      risks: ['short strings'],
      narrative_type: 'cult_culture|news|politics|animal|ai_tech|viral_social_article|charity|big_figure_person|unclear',
      narrative_score: 'number 0-20',
      narrative_notes: 'short explanation of the narrative, why it is strong/weak, and any social-link red flags',
      suggested_tp_percent: 'positive number',
      suggested_sl_percent: 'negative number',
    },
    narrative_framework: {
      importance: 'Narrative quality should influence the ranking of eligible candidates because stronger narratives tend to produce higher-quality trench tokens.',
      categories: {
        cult_culture: 'Absurd, ironic, lore-heavy, almost religious communities with long memetic staying power.',
        news: 'Real-time current events, headlines, tragedies, rescues, random viral stories, or fast information plays.',
        politics: 'Political figures, elections, satire, ideology, government, or campaign cycles.',
        animal: 'Cute/funny animal meta: dogs, cats, squirrels, hippos, frogs, and similar attention magnets.',
        ai_tech: 'AI, GPT, Claude, agents, terminals, bots, infrastructure, or technology/problem-solving narratives.',
        viral_social_article: 'TikTok/X/Instagram/article-driven pure attention plays or influencer-amplified viral loops.',
        charity: 'Donation/cause-driven branding with good-vibes framing but execution risk.',
        big_figure_person: 'Influencer, rapper, athlete, celebrity, or public figure attached to the token identity.',
      },
      red_flags: [
        'Only an X/Twitter quote/status link with weak or missing text.',
        'No website, no Telegram/community surface, and no broader corroboration.',
        'Narrative mismatch between token name/symbol and the linked social text.',
        'Narrative seems already exhausted while chart top-blast risk is high.',
      ],
    },
    trigger_candidate_id: triggerCandidateId,
    candidates: rows.map(compactCandidateForLlm),
  };

  try {
    const res = await axios.post(`${LLM_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      model: LLM_MODEL,
      temperature: 0.2,
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
    const decision = normalizeDecision(parsed);
    const selectedId = Number(parsed.selected_candidate_id);
    const selectedMint = String(parsed.selected_mint || '');
    const row = rows.find(item => item.id === selectedId || item.candidate.token?.mint === selectedMint);
    return {
      ...decision,
      selected_candidate_id: decision.verdict === 'BUY' && row ? row.id : null,
      selected_mint: decision.verdict === 'BUY' && row ? row.candidate.token.mint : null,
      selected_row: decision.verdict === 'BUY' && row ? row : null,
    };
  } catch (err) {
    console.log(`[llm] batch failed: ${err.message}`);
    return {
      verdict: 'WATCH',
      confidence: 0,
      selected_candidate_id: null,
      selected_mint: null,
      reason: `LLM failed: ${err.message}`,
      risks: ['llm_error'],
      suggested_tp_percent: numSetting('default_tp_percent', 50),
      suggested_sl_percent: numSetting('default_sl_percent', -25),
      raw: { error: err.message },
    };
  }
}

export async function decideCandidate(candidate) {
  const pseudoRow = { id: 0, candidate };
  const decision = await decideCandidateBatch([pseudoRow], 0);
  return normalizeDecision(decision.raw || decision, decision.reason);
}
