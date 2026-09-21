// @ts-check
// Aggregates for decisions.jsonl (src/decision/telemetry.js). Pure, so the CLI and the tests share it.

/** @param {number[]} values @param {number} q 0..1 */
export function quantile(values, q) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/**
 * @param {any[]} records parsed lines
 * @param {{lowConfidence?: number, maxGapMs?: number}} [options] maxGapMs: a longer silence counts as downtime
 */
export function summarize(records, options = {}) {
    // the loop's own default threshold (TacticalLoop lowConfidence), so "low" means the same thing in both places
    const low = options.lowConfidence ?? 0.4;
    const maxGapMs = options.maxGapMs ?? 5 * 60_000;
    const calls = records.filter(r => r.kind === 'call');
    const events = records.filter(r => r.kind === 'event');
    const of = (/** @type {string} */ type) => events.filter(e => e.type === type);
    // Time the bot was actually running: the gaps between consecutive records, except long ones (the bot was
    // stopped, or several runs share a file). Sorting also merges several files or a rotated one correctly.
    const times = records.map(r => r.t).filter(Number.isFinite).sort((a, b) => a - b);
    let activeMs = 0;
    for (let i = 1; i < times.length; i++) {
        const gap = times[i] - times[i - 1];
        if (gap <= maxGapMs) activeMs += gap;
    }
    const hours = activeMs / 3_600_000;
    const perHour = (/** @type {number} */ n) => (hours > 0 ? n / hours : null);

    const answered = calls.filter(c => !c.error);
    const latency = (/** @type {any[]} */ cs) => {
        const ms = cs.map(c => c.latencyMs).filter(Number.isFinite);
        return { p50: quantile(ms, 0.5), p95: quantile(ms, 0.95) };
    };
    // the cheap "stop now?" check runs far more often than real decisions and would hide their latency
    const deciding = answered.filter(c => c.purpose !== 'interrupt');
    const checking = answered.filter(c => c.purpose === 'interrupt');
    const tokens = calls.reduce((sum, c) => sum + (c.inputTokens ?? 0) + (c.outputTokens ?? 0), 0);
    const priced = calls.filter(c => Number.isFinite(c.usd));
    const usd = priced.reduce((sum, c) => sum + c.usd, 0);

    const decisions = of('decision');
    const stale = of('stale').length;
    // decisions made without asking a model (a single possible action) are not evidence of confidence
    const confidences = decisions.filter(d => (d.detail?.decisions ?? 1) > 0).map(d => d.detail?.confidence).filter(Number.isFinite);
    const results = of('result');
    const byProvider = /** @type {Record<string, number>} */ ({});
    for (const c of answered) byProvider[c.provider] = (byProvider[c.provider] ?? 0) + 1;

    return {
        hours,
        calls: calls.length,
        failedCalls: calls.length - answered.length,
        byProvider,
        decisions: decisions.length,
        decisionsPerHour: perHour(decisions.length),
        latencyMs: latency(deciding),
        interruptLatencyMs: latency(checking),
        interruptChecks: calls.filter(c => c.purpose === 'interrupt').length,
        tokensPerHour: perHour(tokens),
        usd: priced.length > 0 ? usd : null,
        usdPerHour: priced.length > 0 ? perHour(usd) : null,
        unpricedCalls: answered.length - answered.filter(c => Number.isFinite(c.usd)).length,
        staleRate: decisions.length + stale > 0 ? stale / (decisions.length + stale) : null,
        lowConfidenceRate: confidences.length > 0 ? confidences.filter(c => c < low).length / confidences.length : null,
        results: {
            ok: results.filter(r => r.detail?.ok && !r.detail?.inconclusive).length,
            failed: results.filter(r => !r.detail?.ok && !r.detail?.inconclusive).length,
            inconclusive: results.filter(r => r.detail?.inconclusive).length,
            progressed: results.filter(r => r.detail?.progressed).length,
        },
        interrupts: of('interrupt').length,
        gaveUp: of('gave up').length + of('stuck').filter(e => e.detail?.givenUp).length,
        crashes: of('restored after crash').length,
        deaths: of('death').length,
    };
}

/** @param {ReturnType<typeof summarize>} s */
export function formatSummary(s) {
    const pct = (/** @type {number | null} */ x) => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);
    const num = (/** @type {number | null} */ x, digits = 0) => (x === null ? '-' : x.toFixed(digits));
    return [
        `period            ${num(s.hours, 2)} h`,
        `provider calls    ${s.calls} (${s.failedCalls} failed) ${Object.entries(s.byProvider).map(([p, n]) => `${p}:${n}`).join(' ')}`,
        `decisions         ${s.decisions} (${num(s.decisionsPerHour, 1)}/h)`,
        `latency           decide p50 ${num(s.latencyMs.p50)} ms, p95 ${num(s.latencyMs.p95)} ms; stop-check p50 ${num(s.interruptLatencyMs.p50)} ms (${s.interruptChecks} calls)`,
        `tokens            ${num(s.tokensPerHour)}/h`,
        `cost              $${num(s.usd, 4)} ($${num(s.usdPerHour, 4)}/h)${s.unpricedCalls > 0 ? `, ${s.unpricedCalls} calls unpriced` : ''}`,
        `stale             ${pct(s.staleRate)}`,
        `low confidence    ${pct(s.lowConfidenceRate)} (below the loop's threshold)`,
        `results           ok ${s.results.ok}, failed ${s.results.failed}, inconclusive ${s.results.inconclusive}, progressed ${s.results.progressed}`,
        `interrupts ${s.interrupts}, goals given up ${s.gaveUp}, crashes ${s.crashes}, deaths ${s.deaths}`,
    ].join('\n');
}
