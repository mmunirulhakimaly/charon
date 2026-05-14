import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const ponyinDir = path.join(root, 'artifacts', 'ponyin');

function maybeFixMojibake(value) {
  if (typeof value !== 'string') return value;
  if (!/[âÃðÂ]/.test(value)) return value;
  try {
    const fixed = Buffer.from(value, 'latin1').toString('utf8');
    const originalBad = (value.match(/[âÃðÂ]/g) || []).length;
    const fixedBad = (fixed.match(/[âÃðÂ]/g) || []).length;
    return fixedBad < originalBad ? fixed : value;
  } catch {
    return value;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function nl2br(value) {
  return escapeHtml(value).replace(/\n/g, '<br>');
}

function extractRegex(text, regex, fallback = '') {
  const match = text.match(regex);
  return match?.[1] ?? fallback;
}

function extractObjectLiteral(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start === -1) return null;
  const from = start + startMarker.length;
  const end = source.indexOf(endMarker, from);
  if (end === -1) return null;
  return source.slice(from, end);
}

function evalLiteral(literal) {
  try {
    return vm.runInNewContext(`(${literal})`, {});
  } catch {
    return null;
  }
}

function uniqueSorted(items) {
  return [...new Set(items.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function stripHtml(value) {
  return String(value ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function asciiSanitize(value) {
  return String(value ?? '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, '-')
    .replace(/→/g, '->')
    .replace(/←/g, '<-')
    .replace(/›/g, '>')
    .replace(/•/g, '*')
    .replace(/·/g, '-')
    .replace(/⚠️|⚠/g, '[warn]')
    .replace(/✅/g, '[ok]')
    .replace(/🚨/g, '[alert]')
    .replace(/💡/g, '[idea]')
    .replace(/🧠/g, '[mind]')
    .replace(/💼/g, '[biz]')
    .replace(/📚/g, '[book]')
    .replace(/🔒/g, '[lock]')
    .replace(/✦/g, '[bonus]')
    .replace(/★/g, '[close]')
    .replace(/☀️/g, 'sun')
    .replace(/🌙/g, 'moon')
    .replace(/𝕏/g, 'X')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '');
}

function wrapText(value, width = 96) {
  const lines = [];
  for (const rawLine of String(value ?? '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of line.split(/\s+/)) {
      const next = current ? `${current} ${word}` : word;
      if (next.length <= width) {
        current = next;
      } else {
        if (current) lines.push(current);
        if (word.length <= width) {
          current = word;
        } else {
          let rest = word;
          while (rest.length > width) {
            lines.push(rest.slice(0, width - 1) + '-');
            rest = rest.slice(width - 1);
          }
          current = rest;
        }
      }
    }
    lines.push(current);
  }
  return lines;
}

function pdfEscape(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function buildPdfFromLines(lines, {
  pageWidth = 612,
  pageHeight = 792,
  marginX = 48,
  marginY = 48,
  fontSize = 9,
  leading = 11,
} = {}) {
  const usableLines = Math.floor((pageHeight - marginY * 2) / leading);
  const pages = [];
  for (let i = 0; i < lines.length; i += usableLines) {
    pages.push(lines.slice(i, i + usableLines));
  }

  const objects = [];
  const addObject = (content) => {
    objects.push(content);
    return objects.length;
  };

  const fontId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds = [];

  for (const pageLines of pages) {
    const contentLines = [
      'BT',
      `/F1 ${fontSize} Tf`,
      `${marginX} ${pageHeight - marginY} Td`,
      `${leading} TL`,
      ...pageLines.map((line, index) => `${index === 0 ? '' : 'T* '}(${pdfEscape(line)}) Tj`.trim()),
      'ET',
    ];
    const stream = contentLines.join('\n');
    const contentId = addObject(`<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\nstream\n${stream}\nendstream`);
    const pageId = addObject(`<< /Type /Page /Parent PAGES_ID 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
    pageIds.push(pageId);
  }

  const kids = pageIds.map((id) => `${id} 0 R`).join(' ');
  const pagesId = addObject(`<< /Type /Pages /Count ${pageIds.length} /Kids [${kids}] >>`);
  const catalogId = addObject(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

  objects.forEach((content, index) => {
    if (content.includes('PAGES_ID')) {
      objects[index] = content.replace('PAGES_ID', String(pagesId));
    }
  });

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(pdf, 'utf8');
}

function fileStatSummary(name, content) {
  const lines = content.split(/\r?\n/).length;
  return {
    name,
    lines,
    chars: content.length,
    words: content.trim().split(/\s+/).filter(Boolean).length,
  };
}

const html = await fs.readFile(path.join(ponyinDir, 'index.html'), 'utf8');
const css = await fs.readFile(path.join(ponyinDir, 'index.css'), 'utf8');
const js = await fs.readFile(path.join(ponyinDir, 'index.js'), 'utf8');
const panels = JSON.parse(await fs.readFile(path.join(ponyinDir, 'panels.json'), 'utf8'))
  .map((panel) => ({ ...panel, text: maybeFixMojibake(panel.text) }));
const domSnapshot = maybeFixMojibake(await fs.readFile(path.join(ponyinDir, 'homepage_dom_snapshot.txt'), 'utf8'));

const title = extractRegex(html, /<title>([^<]+)<\/title>/i, 'Ponyin');
const description = extractRegex(html, /<meta name="description"\s+content="([^"]+)"/i, '');
const jsAsset = extractRegex(html, /<script[^>]+src="([^"]+)"/i, '');
const cssAsset = extractRegex(html, /<link rel="stylesheet"[^>]+href="([^"]+)"/i, '');
const antiPrint = /@media print/.test(html) || /@media print/.test(css);
const antiSelect = /user-select:\s*none/i.test(html) || /user-select:\s*none/i.test(css);
const darkTheme = /\[data-theme=dark\]/.test(css);
const chatbot = /chatbot-window/.test(css) || /Ponyin Bot/.test(domSnapshot);

const rawUrls = uniqueSorted([
  ...html.matchAll(/https:\/\/[^\s"'`)<]+/g),
  ...js.matchAll(/https:\/\/[^\s"'`)<]+/g),
].map((match) => match[0]));

const spaceLiteral = extractObjectLiteral(js, 'const Mg=', ';function Ng');
const spaceData = evalLiteral(spaceLiteral) || {};
const spaceId = Array.isArray(spaceData.id) ? spaceData.id.map((space) => ({
  ...space,
  title: maybeFixMojibake(space.title),
  desc: maybeFixMojibake(space.desc),
  tag: maybeFixMojibake(space.tag),
  insights: Array.isArray(space.insights)
    ? space.insights.map((insight) => ({
        ...insight,
        title: maybeFixMojibake(insight.title),
        body: maybeFixMojibake(insight.body),
      }))
    : [],
})) : [];

const scamLiteral = extractObjectLiteral(js, 'const td=', ';function Fg');
const scammers = evalLiteral(scamLiteral) || { twitter: [], tiktok: [] };

const reportFiles = [
  fileStatSummary('index.html', html),
  fileStatSummary('index.css', css),
  fileStatSummary('index.js', js),
  fileStatSummary('homepage_dom_snapshot.txt', domSnapshot),
];

const repoSummary = {
  runtime: 'Node.js ESM app with Telegram bot, SQLite state, signal polling, enrichment, LLM screening, and execution router.',
  controlPlane: [
    '[README.md](/C:/Users/munir/.codex/worktrees/c13c/charon/README.md)',
    '[src/config.js](/C:/Users/munir/.codex/worktrees/c13c/charon/src/config.js)',
    '[src/app.js](/C:/Users/munir/.codex/worktrees/c13c/charon/src/app.js)',
  ],
  keyModules: [
    '[src/db/connection.js](/C:/Users/munir/.codex/worktrees/c13c/charon/src/db/connection.js)',
    '[src/db/settings.js](/C:/Users/munir/.codex/worktrees/c13c/charon/src/db/settings.js)',
    '[src/pipeline/candidateBuilder.js](/C:/Users/munir/.codex/worktrees/c13c/charon/src/pipeline/candidateBuilder.js)',
    '[src/pipeline/orchestrator.js](/C:/Users/munir/.codex/worktrees/c13c/charon/src/pipeline/orchestrator.js)',
    '[src/pipeline/llm.js](/C:/Users/munir/.codex/worktrees/c13c/charon/src/pipeline/llm.js)',
    '[src/signals/serverClient.js](/C:/Users/munir/.codex/worktrees/c13c/charon/src/signals/serverClient.js)',
    '[src/execution/positions.js](/C:/Users/munir/.codex/worktrees/c13c/charon/src/execution/positions.js)',
    '[src/liveExecutor.js](/C:/Users/munir/.codex/worktrees/c13c/charon/src/liveExecutor.js)',
  ],
};

const mappingRows = [
  {
    topic: 'Bundle token / multi-wallet concentration',
    ponyin: 'Vol.1 panel 1 and several Space recordings push traders to read hidden supply concentration rather than naïve wallet counts.',
    charon: 'Mapped to `max_top20_holder_percent`, `trending_max_bundler_rate`, Jupiter holder reads, and saved-wallet exposure in candidate enrichment.',
    files: [
      'src/pipeline/candidateBuilder.js',
      'src/db/connection.js',
      'src/db/settings.js',
    ],
    status: 'Partial fit',
    gap: 'Charon filters concentration and bundler rate, but it does not model identity-clustered wallets or explicit bundle detection beyond upstream metrics.',
  },
  {
    topic: 'Global fees / fake volume detection',
    ponyin: 'Vol.1 panel 2 frames global fees as the cleanest lie detector for wash-traded volume.',
    charon: 'Strongly represented by fee-claim routing and `min_fee_claim_sol` / `min_gmgn_total_fee_sol` gates.',
    files: [
      'src/pipeline/candidateBuilder.js',
      'src/signals/serverClient.js',
      'src/config.js',
    ],
    status: 'Strong fit',
    gap: 'Charon consumes fee signals and GMGN totals, but does not present the ratio explanation to end users the way Ponyin does.',
  },
  {
    topic: 'Revoke / mint authority risk',
    ponyin: 'Vol.1 panel 3 warns that revoke alone is not enough and active mint authority is a red flag.',
    charon: 'No first-class revoke or mint-authority check exists in the current repo.',
    files: [
      'src/pipeline/candidateBuilder.js',
    ],
    status: 'Missing',
    gap: 'This is a clear candidate for a new enrichment source and hard filter.',
  },
  {
    topic: 'Meme vs utility positioning',
    ponyin: 'Vol.1 panel 4 explicitly chooses meme-speed learning over slow fundamental utility analysis.',
    charon: 'Product identity matches: README calls Charon a Solana trench agent focused on noisy Pump-token flow.',
    files: [
      'README.md',
      'src/app.js',
    ],
    status: 'Aligned',
    gap: 'No issue here; the repo already lives on the meme-trading side of the spectrum.',
  },
  {
    topic: 'Dex paid / ads / boosts timing',
    ponyin: 'Vol.1 panel 5 says timing of paid visibility matters more than the presence of paid visibility itself.',
    charon: 'Closest proxy is trending ingestion and hotness / swap / rug / bundler filters.',
    files: [
      'src/signals/serverClient.js',
      'src/pipeline/candidateBuilder.js',
      'src/db/connection.js',
    ],
    status: 'Partial fit',
    gap: 'No explicit DexScreener ads / paid / boost signal is ingested today.',
  },
  {
    topic: 'Three-candle dip confirmation',
    ponyin: 'Vol.1 panel 6 teaches staged entry and confirmation before sizing up.',
    charon: 'The nearest analogue is `dip_buy` plus stored price alerts and ATH-distance triggers.',
    files: [
      'src/db/connection.js',
      'src/signals/serverClient.js',
      'src/signals/priceMonitor.js',
    ],
    status: 'Partial fit',
    gap: 'No literal candle-pattern confirmation exists; execution waits for price conditions, not candle structure.',
  },
  {
    topic: 'Cabal play / who is moving the coin',
    ponyin: 'Vol.1 panel 7 and multiple spaces emphasize knowing the operators behind a move.',
    charon: 'Routes fee/graduated/trending overlap, tracks saved wallets, and exposes trend quality metrics.',
    files: [
      'src/pipeline/candidateBuilder.js',
      'src/signals/serverClient.js',
      'src/enrichment/wallets.js',
    ],
    status: 'Partial fit',
    gap: 'No explicit cabal graph or actor attribution layer exists.',
  },
  {
    topic: 'Holder reading beyond surface counts',
    ponyin: 'Vol.1 panel 8 says raw holder percentages are insufficient in a multi-wallet world.',
    charon: 'Uses holder counts, top-holder concentration, and saved-wallet overlap during filtering and refresh.',
    files: [
      'src/pipeline/candidateBuilder.js',
      'src/execution/positions.js',
      'src/enrichment/wallets.js',
    ],
    status: 'Good fit',
    gap: 'Still lacks wallet-cluster heuristics.',
  },
  {
    topic: 'Market-cap tiers and playbook shifts',
    ponyin: 'Vol.1 panel 9 and advanced panels repeatedly separate microcap behavior from larger caps.',
    charon: 'Directly implemented through per-strategy `min_mcap_usd`, `max_mcap_usd`, graduated volume gates, and strategy-specific size/TP/SL settings.',
    files: [
      'src/db/connection.js',
      'src/db/settings.js',
      'src/pipeline/candidateBuilder.js',
    ],
    status: 'Strong fit',
    gap: 'Could be made more readable in Telegram UX by surfacing the active cap tier logic.',
  },
  {
    topic: 'Money management / partials / moonbag discipline',
    ponyin: 'Advanced panels and spaces stress staged exits, compounding discipline, and not dying from one bad decision.',
    charon: 'Dry-run/live positions support TP, SL, trailing TP, partial TP, max hold, and moonbag LLM review.',
    files: [
      'src/db/connection.js',
      'src/execution/positions.js',
      'src/pipeline/positionReviewer.js',
    ],
    status: 'Strong fit',
    gap: 'The strategy exists in code, but not all of Ponyin’s pedagogical framing is surfaced in docs or bot copy.',
  },
  {
    topic: 'Cheap execution / custom infra / RPC edge',
    ponyin: 'Advanced panels and spaces talk about bots vs terminals, Rust/JS literacy, private RPC, and faster execution.',
    charon: 'Live mode depends on Solana RPC, websocket, Jupiter swap API, and direct signed transaction execution.',
    files: [
      'src/config.js',
      'src/liveExecutor.js',
      'README.md',
    ],
    status: 'Aligned',
    gap: 'Repo uses Jupiter Ultra flow but does not expose infra benchmarking or advanced private-orderflow logic.',
  },
  {
    topic: 'Scam / drainer / opsec education',
    ponyin: 'Advanced security material plus the Scammer section focus on anti-drain hygiene and identity risk.',
    charon: 'Repo validates credentials and isolates trading flows, but it does not implement scammer-list, drainer detection, or wallet-opsec education as product features.',
    files: [
      'src/config.js',
      'src/telegram/menus.js',
    ],
    status: 'Mostly missing',
    gap: 'More of a product-education gap than a trading-logic gap.',
  },
];

const gaps = [
  'Add explicit revoke-authority and mint-authority checks to candidate enrichment and filtering.',
  'Consider a DEX visibility module for Dex Paid / Ads / Boost timing if that data source is available.',
  'Add a wallet-clustering heuristic so multi-wallet bundle patterns are not reduced to plain top-holder percentages.',
  'Expose more of the strategy rationale in Telegram summaries so users see why a candidate passed or failed in Ponyin-style language.',
  'Security education sections from Ponyin could become bot commands or a static help module, especially for drainer / burner-wallet hygiene.',
];

const panelsHtml = panels.map((panel, index) => `
  <section class="panel-block">
    <h3>${index + 1}. ${escapeHtml(panel.name)}</h3>
    <pre>${escapeHtml(panel.text)}</pre>
  </section>
`).join('\n');

const spacesHtml = spaceId.map((space, index) => `
  <section class="space-block">
    <h3>${index + 1}. ${escapeHtml(space.title)}</h3>
    <p><strong>${escapeHtml(space.date)}</strong> · ${escapeHtml(space.tag)} · <a href="${escapeHtml(space.xLink)}">${escapeHtml(space.xLink)}</a></p>
    <p>${escapeHtml(space.desc)}</p>
    ${space.insights.map((insight) => `
      <div class="insight">
        <h4>Insight ${escapeHtml(insight.num)}: ${escapeHtml(insight.title)}</h4>
        <div class="insight-body">${insight.body}</div>
      </div>
    `).join('')}
  </section>
`).join('\n');

const scamHtml = [
  ...(scammers.twitter || []).map((item) => ({ platform: 'X', ...item })),
  ...(scammers.tiktok || []).map((item) => ({ platform: 'TikTok', ...item })),
].map((item) => `
  <tr>
    <td>${escapeHtml(item.platform)}</td>
    <td>${escapeHtml(item.username)}</td>
    <td>${escapeHtml(item.note || '')}</td>
    <td><a href="${escapeHtml(item.link)}">${escapeHtml(item.link)}</a></td>
  </tr>
`).join('\n');

const htmlReport = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Ponyin x Charon Consolidated Report</title>
  <style>
    :root {
      --bg: #f6f8fc;
      --paper: #ffffff;
      --ink: #19212f;
      --muted: #5d6b83;
      --line: #d9e2f1;
      --blue: #2455d4;
      --soft: #eef3ff;
      --warn: #fff4e5;
      --ok: #edf9f1;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", Arial, sans-serif;
      color: var(--ink);
      background: var(--bg);
      line-height: 1.55;
    }
    main {
      max-width: 1100px;
      margin: 0 auto;
      padding: 28px;
    }
    section {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 22px 24px;
      margin-bottom: 18px;
      page-break-inside: avoid;
    }
    h1, h2, h3, h4 { margin: 0 0 12px; line-height: 1.2; }
    h1 { font-size: 34px; }
    h2 { font-size: 24px; padding-bottom: 10px; border-bottom: 1px solid var(--line); }
    h3 { font-size: 18px; }
    h4 { font-size: 15px; }
    p, li { color: var(--ink); }
    .lede { font-size: 16px; color: var(--muted); }
    .meta-grid, .stat-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
    }
    .stat-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .card, .stat {
      background: #fbfcff;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px;
    }
    .stat strong {
      display: block;
      font-size: 24px;
      color: var(--blue);
      margin-bottom: 6px;
    }
    .label {
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: .06em;
      margin-bottom: 4px;
    }
    .banner {
      background: linear-gradient(135deg, #1230a0, #2455d4);
      color: #fff;
    }
    .banner p, .banner li { color: #eef3ff; }
    .note { background: var(--soft); }
    .warn { background: var(--warn); }
    .ok { background: var(--ok); }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      border: 1px solid var(--line);
      padding: 10px 11px;
      vertical-align: top;
      text-align: left;
    }
    th {
      background: var(--soft);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    code {
      font-family: Consolas, monospace;
      font-size: 12px;
      background: #f3f6fc;
      padding: 2px 5px;
      border-radius: 5px;
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: #f9fbff;
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 14px;
      font-family: Consolas, monospace;
      font-size: 12px;
      line-height: 1.5;
      margin: 0;
    }
    .screenshot {
      width: 100%;
      border-radius: 12px;
      border: 1px solid var(--line);
      display: block;
      margin-top: 10px;
    }
    .grid-2 {
      display: grid;
      grid-template-columns: 1.2fr .8fr;
      gap: 18px;
    }
    .mapping td:nth-child(1) { width: 14%; }
    .mapping td:nth-child(5) { width: 10%; }
    .insight {
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px 14px;
      margin: 10px 0 0;
      background: #fcfdff;
    }
    .insight-body {
      color: var(--ink);
      font-size: 13px;
      line-height: 1.6;
    }
    .panel-block, .space-block {
      page-break-inside: avoid;
      margin-bottom: 18px;
    }
    .small {
      font-size: 12px;
      color: var(--muted);
    }
    .appendix-break {
      page-break-before: always;
    }
    @media print {
      body { background: #fff; }
      main { max-width: none; padding: 0; }
      section { border-radius: 0; margin-bottom: 14px; }
      a { color: inherit; text-decoration: none; }
    }
  </style>
</head>
<body>
  <main>
    <section class="banner">
      <div class="label" style="color:#dbe6ff;">Consolidated Audit</div>
      <h1>Ponyin Website x Charon Repo</h1>
      <p class="lede" style="color:#edf3ff;">
        Crawl snapshot of <strong>${escapeHtml(title)}</strong> plus a repo-level consolidation of how Ponyin’s trading logic overlaps, differs from, or is absent inside the current <strong>charon</strong> codebase.
      </p>
      <p class="small" style="color:#dbe6ff;">Generated from live crawl artifacts captured on 2026-05-14.</p>
    </section>

    <section>
      <h2>1. Executive Readout</h2>
      <div class="stat-grid">
        <div class="stat"><strong>${panels.length}</strong><span>Material Panels Captured</span></div>
        <div class="stat"><strong>${spaceId.length}</strong><span>Space Cards Parsed</span></div>
        <div class="stat"><strong>${spaceId.reduce((sum, item) => sum + item.insights.length, 0)}</strong><span>Space Insights Parsed</span></div>
        <div class="stat"><strong>${rawUrls.length}</strong><span>Distinct URLs Seen</span></div>
      </div>
      <p>
        The public site is a single-page React application with a very small HTML shell and a large minified JS bundle carrying almost all learning content. The top layer explicitly blocks print rendering and text selection, but the underlying content remains recoverable through HTML, CSS, JS, DOM snapshotting, and rendered-panel extraction.
      </p>
      <p>
        Charon overlaps strongly with Ponyin on fee-based signal quality, holder concentration, market-cap gating, multi-wallet-aware thinking, and disciplined TP/SL execution. The biggest missing areas are revoke/mint authority checks, paid-visibility timing signals, richer wallet clustering, and security/education features that Ponyin surfaces directly to users.
      </p>
    </section>

    <section>
      <h2>2. Crawl Inventory</h2>
      <div class="grid-2">
        <div>
          <div class="meta-grid">
            <div class="card">
              <div class="label">Title</div>
              <div>${escapeHtml(title)}</div>
            </div>
            <div class="card">
              <div class="label">Description</div>
              <div>${escapeHtml(description)}</div>
            </div>
            <div class="card">
              <div class="label">Primary JS Asset</div>
              <div><code>${escapeHtml(jsAsset)}</code></div>
            </div>
            <div class="card">
              <div class="label">Primary CSS Asset</div>
              <div><code>${escapeHtml(cssAsset)}</code></div>
            </div>
            <div class="card ${antiPrint ? 'warn' : 'ok'}">
              <div class="label">Anti-Print Layer</div>
              <div>${antiPrint ? 'Present in shell/CSS' : 'Not detected'}</div>
            </div>
            <div class="card ${antiSelect ? 'warn' : 'ok'}">
              <div class="label">Anti-Selection Layer</div>
              <div>${antiSelect ? 'Present in shell/CSS' : 'Not detected'}</div>
            </div>
            <div class="card ${darkTheme ? 'ok' : 'note'}">
              <div class="label">Dark Theme</div>
              <div>${darkTheme ? 'Implemented' : 'Not detected'}</div>
            </div>
            <div class="card ${chatbot ? 'ok' : 'note'}">
              <div class="label">Chatbot Surface</div>
              <div>${chatbot ? 'Detected in DOM/CSS' : 'Not detected'}</div>
            </div>
          </div>
          <p class="small">
            Archive files captured locally: ${reportFiles.map((item) => `<code>${escapeHtml(item.name)}</code>`).join(', ')}, plus rendered panel dumps, screenshots, and parsed JSON artifacts.
          </p>
        </div>
        <div>
          <div class="card">
            <div class="label">Rendered Homepage Snapshot</div>
            <img class="screenshot" src="homepage_full.png" alt="Ponyin homepage screenshot">
          </div>
        </div>
      </div>
    </section>

    <section>
      <h2>3. Site Architecture</h2>
      <ul>
        <li>HTML shell is intentionally thin: root app mount, title, description, one CSS bundle, one JS bundle, and anti-copy / anti-print styles.</li>
        <li>CSS bundle is large and opinionated: fixed navbar, hero split layout, material sidebar, space cards, proof gallery, scammer section, chatbot, language toggle, and dark theme.</li>
        <li>React bundle stores substantive educational content directly inside JavaScript constants rather than fetching it from an API at runtime.</li>
        <li>Material navigation is panel-based: Vol.1 basic lessons, a closing panel, and Vol.2 advanced / bonus sections.</li>
        <li>Supporting sections include Space Recordings, proof-of-PnL gallery, scammer list, footer links, partner CTA, and bot UI.</li>
      </ul>
      <table>
        <thead>
          <tr><th>Captured File</th><th>Lines</th><th>Words</th><th>Characters</th></tr>
        </thead>
        <tbody>
          ${reportFiles.map((item) => `
            <tr>
              <td>${escapeHtml(item.name)}</td>
              <td>${item.lines}</td>
              <td>${item.words}</td>
              <td>${item.chars}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </section>

    <section>
      <h2>4. Public Sections Found</h2>
      <ul>
        <li>Navbar with live SOL price strip, language toggle, dark-mode toggle, X link, and Trojan CTA.</li>
        <li>Hero section with Telegram partnership bar, educational positioning, and primary reading CTA.</li>
        <li>Material intro showing 9 basic lessons, 9 advance slots, and coming-soon framing.</li>
        <li>Vol.1 basic lesson panels: Bundle Token, Global Fees, Revoke & Minting, Meme vs Utility, Dex Paid/Ads/Boost, 3 Konfirmasi Candle, Cabal Play, Membaca Holder, Market Cap Tier.</li>
        <li>Closing / Penutup panel plus Vol.2 advance panels: Snipe Early, First 1K, Wallet Ping, Money Management, Transaksi Murah, Rent Refund, Instant Scalping, Day Phase Trade, Multi Wallet, Unwritten Rules, Skema Penipuan.</li>
        <li>Space Recordings section with ${spaceId.length} cards and ${spaceId.reduce((sum, item) => sum + item.insights.length, 0)} parsed insight bodies.</li>
        <li>Proof gallery based on PnL screenshots.</li>
        <li>Scammer section listing X/TikTok handles marked as scams.</li>
        <li>Footer with X, Trojan, and copyright / anti-copy statement.</li>
      </ul>
    </section>

    <section>
      <h2>5. Charon Repo Summary</h2>
      <p>${escapeHtml(repoSummary.runtime)}</p>
      <p><strong>Control-plane files:</strong> ${repoSummary.controlPlane.join(', ')}</p>
      <p><strong>Core logic modules:</strong> ${repoSummary.keyModules.join(', ')}</p>
      <ul>
        <li><code>src/config.js</code> centralizes env-driven settings for Telegram, Solana RPC, GMGN, Jupiter, LLM, polling, and validation.</li>
        <li><code>src/app.js</code> starts DB, Telegram, live execution, signal polling, dip monitor, and position monitor.</li>
        <li><code>src/db/connection.js</code> seeds SQLite tables plus default settings and strategy definitions.</li>
        <li><code>src/pipeline/candidateBuilder.js</code> builds enriched token candidates and applies strategy filters.</li>
        <li><code>src/pipeline/orchestrator.js</code> batches candidates, requests LLM selection, and routes dry-run / confirm / live actions.</li>
        <li><code>src/execution/positions.js</code> handles refresh, trailing logic, partial TP, moonbag review, and auto-exit.</li>
        <li><code>src/liveExecutor.js</code> signs and executes Jupiter swaps against the configured wallet and RPC.</li>
      </ul>
    </section>

    <section>
      <h2>6. Consolidation Matrix</h2>
      <table class="mapping">
        <thead>
          <tr>
            <th>Topic</th>
            <th>Ponyin Logic</th>
            <th>Charon Logic</th>
            <th>Key Files</th>
            <th>Status</th>
            <th>Gap / Comment</th>
          </tr>
        </thead>
        <tbody>
          ${mappingRows.map((row) => `
            <tr>
              <td><strong>${escapeHtml(row.topic)}</strong></td>
              <td>${escapeHtml(row.ponyin)}</td>
              <td>${escapeHtml(row.charon)}</td>
              <td>${row.files.map((file) => `<code>${escapeHtml(file)}</code>`).join('<br>')}</td>
              <td>${escapeHtml(row.status)}</td>
              <td>${escapeHtml(row.gap)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </section>

    <section>
      <h2>7. Outbound Entities Seen</h2>
      <p class="small">Distinct URLs observed across HTML/JS snapshot.</p>
      <pre>${escapeHtml(rawUrls.join('\n'))}</pre>
    </section>

    <section>
      <h2>8. Security / Integrity Notes</h2>
      <ul>
        <li>The site tries to suppress easy printing and copying, but the educational payload remains embedded in client assets.</li>
        <li>Partner and platform CTAs point heavily toward Trojan, Telegram, and X.</li>
        <li>The proof section is explicitly described as screenshot-first proof, not a fully contextualized trade journal.</li>
        <li>The scammer list is content, not code-backed reputation logic; the repo does not presently consume or enforce that data.</li>
      </ul>
    </section>

    <section>
      <h2>9. Recommended Repo Follow-Ups</h2>
      <ol>
        ${gaps.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}
      </ol>
    </section>

    <section class="appendix-break">
      <h2>Appendix A. Scammer List Captured</h2>
      <table>
        <thead>
          <tr><th>Platform</th><th>Handle</th><th>Note</th><th>Link</th></tr>
        </thead>
        <tbody>${scamHtml}</tbody>
      </table>
    </section>

    <section>
      <h2>Appendix B. Material Panels (Rendered Panel Dumps)</h2>
      ${panelsHtml}
    </section>

    <section class="appendix-break">
      <h2>Appendix C. Space Recordings (Parsed From JS Bundle)</h2>
      <p class="small">These are the detailed insight bodies stored in the site bundle, not just the collapsed card headings.</p>
      ${spacesHtml}
    </section>
  </main>
</body>
</html>`;

const reportPath = path.join(ponyinDir, 'ponyin_charon_consolidated_report.html');
await fs.writeFile(reportPath, htmlReport, 'utf8');

const textSections = [
  'PONYIN x CHARON CONSOLIDATED REPORT',
  `Generated: 2026-05-14`,
  '',
  'EXECUTIVE READOUT',
  `- Material panels captured: ${panels.length}`,
  `- Space cards parsed: ${spaceId.length}`,
  `- Space insights parsed: ${spaceId.reduce((sum, item) => sum + item.insights.length, 0)}`,
  `- Distinct URLs seen: ${rawUrls.length}`,
  '',
  asciiSanitize(`The public site is a single-page React application with anti-print and anti-selection layers, but its core educational content is embedded directly in client assets and recoverable through crawl artifacts.`),
  asciiSanitize(`Charon overlaps strongly with Ponyin on fee quality, holder concentration, market-cap gating, and disciplined execution. The main gaps are revoke/mint authority checks, Dex Paid/Ads/Boost timing, wallet clustering, and explicit security education.`),
  '',
  'CRAWL INVENTORY',
  ...reportFiles.map((item) => `- ${item.name}: ${item.lines} lines, ${item.words} words, ${item.chars} chars`),
  `- Anti-print layer present: ${antiPrint ? 'yes' : 'no'}`,
  `- Anti-selection layer present: ${antiSelect ? 'yes' : 'no'}`,
  `- Dark theme detected: ${darkTheme ? 'yes' : 'no'}`,
  `- Chatbot surface detected: ${chatbot ? 'yes' : 'no'}`,
  '',
  'SITE ARCHITECTURE',
  '- Thin HTML shell with React mount and asset references.',
  '- Large CSS bundle with hero, sidebar, panels, proof gallery, scammer list, chatbot, theme toggle.',
  '- Large JS bundle containing lesson content, space summaries, and UI data.',
  '- Material navigation uses panel switching inside a single-page app.',
  '',
  'CHARON REPO SUMMARY',
  asciiSanitize(repoSummary.runtime),
  `- Control-plane files: ${repoSummary.controlPlane.join('; ')}`,
  `- Core logic modules: ${repoSummary.keyModules.join('; ')}`,
  '',
  'CONSOLIDATION MATRIX',
  ...mappingRows.flatMap((row, index) => [
    `${index + 1}. ${asciiSanitize(row.topic)}`,
    `   Ponyin: ${asciiSanitize(row.ponyin)}`,
    `   Charon: ${asciiSanitize(row.charon)}`,
    `   Files: ${row.files.join(', ')}`,
    `   Status: ${asciiSanitize(row.status)}`,
    `   Gap: ${asciiSanitize(row.gap)}`,
    '',
  ]),
  'RECOMMENDED REPO FOLLOW-UPS',
  ...gaps.map((item, index) => `${index + 1}. ${asciiSanitize(item)}`),
  '',
  'OUTBOUND URL INVENTORY',
  ...rawUrls.map((url) => `- ${asciiSanitize(url)}`),
  '',
  'SCAMMER LIST',
  ...[
    ...(scammers.twitter || []).map((item) => `- X | ${asciiSanitize(item.username)} | ${asciiSanitize(item.note || '')} | ${asciiSanitize(item.link)}`),
    ...(scammers.tiktok || []).map((item) => `- TikTok | ${asciiSanitize(item.username)} | ${asciiSanitize(item.note || '')} | ${asciiSanitize(item.link)}`),
  ],
  '',
  'APPENDIX B. MATERIAL PANELS',
  ...panels.flatMap((panel, index) => [
    '',
    `${index + 1}. ${asciiSanitize(panel.name)}`,
    asciiSanitize(panel.text),
  ]),
  '',
  'APPENDIX C. SPACE RECORDINGS',
  ...spaceId.flatMap((space, index) => [
    '',
    `${index + 1}. ${asciiSanitize(space.title)}`,
    `Date: ${asciiSanitize(space.date)} | Tag: ${asciiSanitize(space.tag)} | Link: ${asciiSanitize(space.xLink)}`,
    asciiSanitize(space.desc),
    ...space.insights.flatMap((insight) => [
      `  - Insight ${asciiSanitize(insight.num)}: ${asciiSanitize(insight.title)}`,
      asciiSanitize(stripHtml(insight.body)),
    ]),
  ]),
];

const wrappedLines = textSections.flatMap((section) => wrapText(section, 96));
const pdfBuffer = buildPdfFromLines(wrappedLines);
const pdfPath = path.join(ponyinDir, 'ponyin_charon_consolidated_report.pdf');
await fs.writeFile(pdfPath, pdfBuffer);

console.log(reportPath);
