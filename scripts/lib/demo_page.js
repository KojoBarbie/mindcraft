// @ts-check
// The page scripts/demo.js writes: the footage (frames packed into a few JPEG sheets, drawn onto a canvas) next
// to a timeline of what the bot decided and why, kept in step. One self-contained HTML file plus the sheets,
// so it opens from disk or publishes as a private page.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

export const FRAME_W = 480;
export const FRAME_H = 270;
const COLS = 10;
const ROWS = 10;

/**
 * Pack frames/00000.jpg ... into sheets of COLS x ROWS frames: a few big images instead of hundreds of small
 * ones (a published page takes at most 255 files).
 * @param {string} framesDir
 * @param {number} count
 * @param {string} out
 * @returns {Promise<string[]>} sheet file names, relative to out
 */
export async function packSheets(framesDir, count, out) {
    const { createCanvas, loadImage } = require('canvas');
    /** @type {string[]} */
    const sheets = [];
    const perSheet = COLS * ROWS;
    for (let s = 0; s * perSheet < count; s++) {
        const n = Math.min(perSheet, count - s * perSheet);
        const rows = Math.ceil(n / COLS);
        const canvas = createCanvas(FRAME_W * COLS, FRAME_H * rows);
        const ctx = canvas.getContext('2d');
        for (let k = 0; k < n; k++) {
            const img = await loadImage(join(framesDir, `${String(s * perSheet + k).padStart(5, '0')}.jpg`));
            ctx.drawImage(img, (k % COLS) * FRAME_W, Math.floor(k / COLS) * FRAME_H, FRAME_W, FRAME_H);
        }
        const file = `sheet-${String(s).padStart(2, '0')}.jpg`;
        writeFileSync(join(out, file), canvas.toBuffer('image/jpeg', { quality: 0.72 }));
        sheets.push(file);
    }
    return sheets;
}

/** What a command does, in words a viewer recognises; the command itself is shown beside it. */
const VERBS = /** @type {Record<string, string>} */ ({
    collectBlocks: '集める', craftRecipe: '作る', smeltItem: '精錬する', searchForBlock: '探しに行く',
    searchForEntity: '探しに行く', moveAway: '歩いて探索する', attack: '倒す', consume: '食べる', equip: '装備する',
    explore: '歩いて探索する', shelter: '穴を掘って籠もる', goToSurface: '地上へ出る', digDown: '掘り下げる', placeHere: '置く', stay: '待つ',
    goToBed: 'ベッドで寝る', takeFromChest: 'チェストから取る', putInChest: 'チェストにしまう', givePlayer: '渡す',
    goToPlayer: 'プレイヤーの所へ行く', followPlayer: 'ついて行く', clearFurnace: 'かまどから取り出す', discard: '捨てる',
});

/** @param {string} command e.g. '!collectBlocks("oak_log", 3)' */
export function describeCommand(command) {
    const m = /^!(\w+)\((.*)\)$/.exec(command ?? '');
    if (!m) return command ?? '';
    const verb = VERBS[m[1]] ?? m[1];
    const parts = m[2].split(',').map(p => p.trim().replace(/^"|"$/g, '')).filter(Boolean);
    if (m[1] === 'moveAway' || m[1] === 'stay' || m[1] === 'explore') return verb;
    const [what, n] = parts;
    return what ? `${what}${n ? ` ×${n}` : ''} を${verb}` : verb;
}

/**
 * @typedef {{t: number, kind: string, title: string, detail?: string, code?: string, meta?: string}} Entry
 */

/**
 * @param {{request: string, startedAt: number, requestedAt: number, telemetry: any[]}} run
 * @returns {Entry[]}
 */
export function buildTimeline(run) {
    /** @type {Entry[]} */
    const entries = [{ t: run.requestedAt || run.startedAt, kind: 'request', title: 'プレイヤーの依頼', detail: run.request }];
    const pct = (/** @type {number | null | undefined} */ c) => (typeof c === 'number' ? `確信度 ${Math.round(c * 100)}%` : '');
    for (const r of run.telemetry) {
        if (r.kind === 'strategy') {
            entries.push({
                t: r.t, kind: 'strategy', title: r.error ? '戦略層: 失敗' : '戦略層が目標に分解',
                detail: r.error ?? [...(r.accepted ?? []).map((/** @type {string} */ g) => `・${g}`), r.reply ? `返答「${r.reply}」` : ''].filter(Boolean).join('\n'),
                meta: [r.model, typeof r.latencyMs === 'number' ? `${(r.latencyMs / 1000).toFixed(1)} 秒` : ''].filter(Boolean).join(' · '),
            });
            continue;
        }
        if (r.kind !== 'event') continue;
        const d = r.detail ?? {};
        switch (r.type) {
            case 'decision':
                entries.push({
                    t: r.t, kind: 'decision', title: describeCommand(d.command), code: d.command,
                    detail: d.goal ? `目標: ${d.goal}` : undefined,
                    meta: [d.decisions === 0 ? '計画どおり（モデル呼び出しなし）' : pct(d.confidence), typeof d.latencyMs === 'number' && d.decisions > 0 ? `${Math.round(d.latencyMs)} ms` : '', d.provider].filter(Boolean).join(' · '),
                });
                break;
            case 'result': {
                const ok = d.ok && !d.inconclusive;
                entries.push({
                    t: r.t, kind: d.inconclusive ? 'neutral' : d.ok ? 'ok' : 'fail',
                    title: `${ok ? '完了' : d.inconclusive ? '中断・結果なし' : '失敗'}: ${describeCommand(d.command)}`,
                    detail: d.output ? String(d.output).replace(/^Action output:\s*/, '').slice(0, 240) : undefined,
                });
                break;
            }
            case 'dusk': entries.push({ t: r.t, kind: 'night', title: '日没: 作業を止める', detail: String(d) }); break;
            case 'night': entries.push({ t: r.t, kind: 'night', title: typeof d === 'object' && d.action ? `夜: 穴を掘って籠もる（${d.attempt} 回目）` : `夜: ${d}` }); break;
            case 'sheltered': entries.push({ t: r.t, kind: 'night', title: '籠もり完了: 朝まで待機（AI 呼び出しなし）' }); break;
            case 'dawn': entries.push({ t: r.t, kind: 'night', title: '夜明け: 地上へ戻る' }); break;
            case 'death': entries.push({ t: r.t, kind: 'fail', title: '死亡', detail: d?.count ? `達成済みの目標 ${d.count} 件をやり直し` : undefined }); break;
            case 'interrupt': entries.push({ t: r.t, kind: 'fail', title: '危険を察知して中断', detail: String(d.action ?? ''), meta: typeof d.probability === 'number' ? `危険度 ${Math.round(d.probability * 100)}%` : '' }); break;
            case 'gave up': entries.push({ t: r.t, kind: 'fail', title: `諦めた: ${d.goal}`, detail: d.reason }); break;
            case 'stuck': if (d.givenUp) entries.push({ t: r.t, kind: 'fail', title: `手段が見つからず諦めた: ${d.goal}`, detail: (d.items ?? []).join(', ') }); break;
            case 'restored after crash': entries.push({ t: r.t, kind: 'fail', title: '固まって再起動、続きから再開', detail: d.reason, code: d.bannedSuspect ?? undefined }); break;
            case 'low confidence': entries.push({ t: r.t, kind: 'neutral', title: '迷っている（確信度が低い）', code: d.command, meta: pct(d.confidence) }); break;
            default: break;
        }
    }
    return entries.sort((a, b) => a.t - b.t);
}

/** @param {string} s */
const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

/**
 * @param {{request: string, startedAt: number, requestedAt: number, doneAt: number | null, fps: number,
 *   frames: any[], sheets: string[], timeline: Entry[], usage: any[], telemetry: any[]}} run
 */
export function renderPage(run) {
    const t0 = run.frames[0]?.t ?? run.startedAt;
    const calls = run.telemetry.filter(r => r.kind === 'call');
    const decisions = run.telemetry.filter(r => r.kind === 'event' && r.type === 'decision').length;
    const deaths = run.telemetry.filter(r => r.kind === 'event' && r.type === 'death').length;
    const took = run.doneAt ? Math.round((run.doneAt - run.requestedAt) / 1000) : null;
    const data = {
        t0, fps: run.fps, fw: FRAME_W, fh: FRAME_H, cols: COLS, perSheet: COLS * ROWS, sheets: run.sheets,
        frames: run.frames.map(f => ({ t: f.t - t0, h: f.health, f: f.food, g: f.goal, n: f.timeOfDay,
            inv: Object.entries(f.inventory ?? {}).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 8) })),
        events: run.timeline.map(e => ({ ...e, t: Math.max(0, e.t - t0) })),
    };
    const summary = [
        took !== null ? `完了まで ${Math.floor(took / 60)}分${took % 60}秒` : '時間内に未完了',
        `判断 ${decisions} 回`, `AI 呼び出し ${calls.length + run.usage.length} 回`, deaths ? `死亡 ${deaths} 回` : '死亡なし',
    ];
    return `<title>ボットの行動記録</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DotGothic16&family=IBM+Plex+Sans+JP:wght@400;500;700&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
:root {
  --ground: #eef1ec; --panel: #f9faf7; --ink: #1c2420; --muted: #5d6b63; --line: #d3dbd3;
  --decision: #1f7f86; --ok: #3d7a34; --fail: #b3362c; --night: #4a4e9c; --strategy: #8a5a12;
  --screen: #0f1512;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ground: #121714; --panel: #19201c; --ink: #e3e9e4; --muted: #95a39a; --line: #2c3730;
    --decision: #5cc2c9; --ok: #7fc070; --fail: #ef7a6e; --night: #9ea3f0; --strategy: #e0ad5c; --screen: #050806;
  }
}
:root[data-theme="dark"] {
  --ground: #121714; --panel: #19201c; --ink: #e3e9e4; --muted: #95a39a; --line: #2c3730;
  --decision: #5cc2c9; --ok: #7fc070; --fail: #ef7a6e; --night: #9ea3f0; --strategy: #e0ad5c; --screen: #050806;
}
body { background: var(--ground); color: var(--ink); font: 15px/1.6 "IBM Plex Sans JP", "Hiragino Sans", system-ui, sans-serif; }
.wrap { max-width: 1240px; margin: 0 auto; padding-inline: 16px; padding-block: 20px 40px; display: grid; gap: 18px; }
header { display: grid; gap: 8px; }
.eyebrow { font: 13px/1 "DotGothic16", monospace; letter-spacing: .08em; color: var(--muted); }
h1 { margin: 0; font: 400 clamp(22px, 3.2vw, 32px)/1.3 "DotGothic16", "IBM Plex Sans JP", sans-serif; text-wrap: balance; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font-size: 13px; padding: 2px 10px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); font-variant-numeric: tabular-nums; }
.stage { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr); gap: 18px; align-items: start; }
@media (max-width: 860px) { .stage { grid-template-columns: 1fr; } }
.player { display: grid; gap: 10px; }
.screen { position: relative; background: var(--screen); border-radius: 6px; overflow: hidden; }
canvas { display: block; width: 100%; height: auto; aspect-ratio: 16 / 9; max-width: 100%; image-rendering: pixelated; }
.hud { position: absolute; left: 10px; top: 10px; display: flex; gap: 6px; flex-wrap: wrap; }
.hud span { font: 12px/1 "JetBrains Mono", monospace; color: #fff; background: rgba(0,0,0,.55); padding: 5px 7px; border-radius: 4px; }
.controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
button { font: inherit; font-size: 14px; color: var(--ink); background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 6px 12px; cursor: pointer; }
button:focus-visible, input:focus-visible, li:focus-visible { outline: 2px solid var(--decision); outline-offset: 2px; }
button[aria-pressed="true"] { border-color: var(--decision); color: var(--decision); }
.time { font: 13px "JetBrains Mono", monospace; color: var(--muted); font-variant-numeric: tabular-nums; }
.track { position: relative; height: 26px; }
.track input { position: absolute; inset: 0; width: 100%; margin: 0; accent-color: var(--decision); }
.ticks { position: absolute; left: 0; right: 0; bottom: 0; height: 6px; pointer-events: none; }
.ticks i { position: absolute; bottom: 0; width: 2px; height: 6px; border-radius: 1px; }
.state { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
.state div { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; }
.state b { display: block; font-size: 12px; color: var(--muted); font-weight: 500; letter-spacing: .04em; }
.state p { margin: 2px 0 0; font-size: 14px; }
.log { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; display: grid; grid-template-rows: auto 1fr; max-height: min(78vh, 760px); }
.log h2 { margin: 0; padding: 10px 14px; font: 400 15px "DotGothic16", sans-serif; border-bottom: 1px solid var(--line); }
ol { list-style: none; margin: 0; padding: 6px 0; overflow-y: auto; }
li { display: grid; grid-template-columns: 52px 1fr; gap: 10px; padding: 7px 14px 7px 10px; border-left: 3px solid transparent; cursor: pointer; }
li:hover { background: color-mix(in srgb, var(--decision) 6%, transparent); }
li.past { opacity: .62; }
li.now { opacity: 1; background: color-mix(in srgb, var(--decision) 11%, transparent); }
li .at { font: 12px/1.9 "JetBrains Mono", monospace; color: var(--muted); font-variant-numeric: tabular-nums; }
li .title { font-weight: 500; }
li .detail { color: var(--muted); font-size: 13px; white-space: pre-line; overflow-wrap: anywhere; }
li code { font: 12px "JetBrains Mono", monospace; color: var(--muted); overflow-wrap: anywhere; }
li .meta { font-size: 12px; color: var(--muted); }
li[data-kind="decision"] { border-left-color: var(--decision); }
li[data-kind="ok"] .title { color: var(--ok); }
li[data-kind="fail"] { border-left-color: var(--fail); } li[data-kind="fail"] .title { color: var(--fail); }
li[data-kind="night"] { border-left-color: var(--night); } li[data-kind="night"] .title { color: var(--night); }
li[data-kind="strategy"], li[data-kind="request"] { border-left-color: var(--strategy); }
li[data-kind="request"] .title, li[data-kind="strategy"] .title { color: var(--strategy); }
.note { font-size: 13px; color: var(--muted); max-width: 70ch; }
@media (prefers-reduced-motion: reduce) { ol { scroll-behavior: auto; } }
</style>
<div class="wrap">
  <header>
    <div class="eyebrow">MINDCRAFT × JEV · 行動記録</div>
    <h1>「${esc(run.request)}」</h1>
    <div class="chips">${summary.map(s => `<span class="chip">${esc(s)}</span>`).join('')}</div>
  </header>
  <div class="stage">
    <section class="player" aria-label="映像">
      <div class="screen"><canvas id="screen" width="${FRAME_W}" height="${FRAME_H}"></canvas><div class="hud" id="hud"></div></div>
      <div class="track"><input id="seek" type="range" min="0" max="${Math.max(0, run.frames.length - 1)}" value="0" aria-label="再生位置"><div class="ticks" id="ticks"></div></div>
      <div class="controls">
        <button id="play" type="button">▶ 再生</button>
        <button type="button" data-speed="1" aria-pressed="true">1×</button>
        <button type="button" data-speed="4" aria-pressed="false">4×</button>
        <button type="button" data-speed="10" aria-pressed="false">10×</button>
        <span class="time" id="clock">0:00</span>
      </div>
      <div class="state">
        <div><b>いまの目標</b><p id="goal">-</p></div>
        <div><b>持ち物</b><p id="inv">-</p></div>
      </div>
      <p class="note">ボットの後ろから撮影した映像（${run.fps} コマ/秒）です。右の記録を押すとその時点へ移動します。確信度は判断モデル Jev が出す確率、「計画どおり」はプランナが次の一手を決めてモデルを呼ばなかった判断です。</p>
    </section>
    <section class="log" aria-label="判断の記録">
      <h2>判断の記録</h2>
      <ol id="events"></ol>
    </section>
  </div>
</div>
<script>
const D = ${JSON.stringify(data).replace(/</g, '\\u003c')};
const canvas = document.getElementById('screen'), ctx = canvas.getContext('2d');
const seek = document.getElementById('seek'), clock = document.getElementById('clock');
const list = document.getElementById('events');
const images = D.sheets.map(src => { const img = new Image(); img.src = src; img.onload = () => draw(); return img; });
let i = 0, playing = false, speed = 1, timer = null;
const fmt = ms => { const s = Math.floor(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const color = k => getComputedStyle(document.documentElement).getPropertyValue(k === 'fail' ? '--fail' : k === 'night' ? '--night' : k === 'strategy' || k === 'request' ? '--strategy' : '--decision');
const frameAt = t => { let lo = 0, hi = D.frames.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (D.frames[m].t <= t) lo = m; else hi = m - 1; } return lo; };
const last = D.frames.length ? D.frames[D.frames.length - 1].t || 1 : 1;
const ticks = document.getElementById('ticks');
for (const e of D.events) if (e.kind !== 'ok' && e.kind !== 'neutral') {
  const tick = document.createElement('i'); tick.style.left = (100 * e.t / last) + '%'; tick.style.background = color(e.kind); ticks.appendChild(tick);
}
const items = D.events.map(e => {
  const li = document.createElement('li'); li.tabIndex = 0; li.dataset.kind = e.kind;
  const at = document.createElement('span'); at.className = 'at'; at.textContent = fmt(e.t);
  const body = document.createElement('div');
  const add = (cls, text, tag = 'div') => { if (!text) return; const el = document.createElement(tag); el.className = cls; el.textContent = text; body.appendChild(el); };
  add('title', e.title); add('detail', e.detail); if (e.code) { const c = document.createElement('code'); c.textContent = e.code; body.appendChild(c); } add('meta', e.meta);
  li.append(at, body);
  const go = () => { show(frameAt(e.t)); };
  li.addEventListener('click', go); li.addEventListener('keydown', ev => { if (ev.key === 'Enter') go(); });
  list.appendChild(li); return li;
});
function draw() {
  const f = D.frames[i]; if (!f) return;
  const img = images[Math.floor(i / D.perSheet)], k = i % D.perSheet;
  if (img && img.complete && img.naturalWidth) ctx.drawImage(img, (k % D.cols) * D.fw, Math.floor(k / D.cols) * D.fh, D.fw, D.fh, 0, 0, D.fw, D.fh);
  const hud = document.getElementById('hud'); hud.textContent = '';
  const add = t => { const s = document.createElement('span'); s.textContent = t; hud.appendChild(s); };
  if (f.h != null) add('体力 ' + f.h + '/20'); if (f.f != null) add('空腹 ' + f.f + '/20');
  if (f.n != null) add(f.n >= 12000 && f.n < 23300 ? '夜' : '昼');
  document.getElementById('goal').textContent = f.g || '（目標なし）';
  document.getElementById('inv').textContent = f.inv.length ? f.inv.map(([n, c]) => n + ' ×' + c).join('、') : '（空）';
  clock.textContent = fmt(f.t) + ' / ' + fmt(last);
  let now = -1; D.events.forEach((e, j) => { if (e.t <= f.t) now = j; });
  items.forEach((li, j) => { li.classList.toggle('past', j < now); li.classList.toggle('now', j === now); });
  if (now >= 0) { const li = items[now]; const top = li.offsetTop - list.offsetTop - list.clientHeight / 3; list.scrollTo({ top, behavior: playing ? 'auto' : 'smooth' }); }
}
function show(n) { i = Math.max(0, Math.min(D.frames.length - 1, n)); seek.value = i; draw(); }
function loop() { if (!playing) return; if (i >= D.frames.length - 1) { toggle(false); return; } show(i + 1); timer = setTimeout(loop, 1000 / (D.fps * speed)); }
function toggle(on) { playing = on; document.getElementById('play').textContent = on ? '❚❚ 一時停止' : '▶ 再生'; clearTimeout(timer); if (on) loop(); }
document.getElementById('play').addEventListener('click', () => toggle(!playing));
seek.addEventListener('input', () => show(Number(seek.value)));
document.querySelectorAll('[data-speed]').forEach(b => b.addEventListener('click', () => {
  speed = Number(b.dataset.speed); document.querySelectorAll('[data-speed]').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
}));
show(0);
</script>
`;
}
