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
 * @param {{lowConfidence?: number}} [options]
 */
export function summarize(records, options = {}) {
    const low = options.lowConfidence ?? 0.6;
    const calls = records.filter(r => r.kind === 'call');
    const events = records.filter(r => r.kind === 'event');
    const of = (/** @type {string} */ type) => events.filter(e => e.type === type);
    const times = records.map(r => r.t).filter(Number.isFinite);
    const hours = times.length > 1 ? (Math.max(...times) - Math.min(...times)) / 3_600_000 : 0;
    const perHour = (/** @type {number} */ n) => (hours > 0 ? n / hours : null);

    const answered = calls.filter(c => !c.error);
    const latencies = answered.map(c => c.latencyMs).filter(Number.isFinite);
    const tokens = calls.reduce((sum, c) => sum + (c.inputTokens ?? 0) + (c.outputTokens ?? 0), 0);
    const priced = calls.filter(c => Number.isFinite(c.usd));
    const usd = priced.reduce((sum, c) => sum + c.usd, 0);

    const decisions = of('decision');
    const stale = of('stale').length;
    const confidences = decisions.map(d => d.detail?.confidence).filter(Number.isFinite);
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
        latencyMs: { p50: quantile(latencies, 0.5), p95: quantile(latencies, 0.95) },
        tokensPerHour: perHour(tokens),
        usd: priced.length > 0 ? usd : null,
        usdPerHour: priced.length > 0 ? perHour(usd) : null,
        unpricedCalls: calls.length - priced.length,
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
        `latency           p50 ${num(s.latencyMs.p50)} ms, p95 ${num(s.latencyMs.p95)} ms`,
        `tokens            ${num(s.tokensPerHour)}/h`,
        `cost              $${num(s.usd, 4)} ($${num(s.usdPerHour, 4)}/h)${s.unpricedCalls > 0 ? `, ${s.unpricedCalls} calls unpriced` : ''}`,
        `stale             ${pct(s.staleRate)}`,
        `low confidence    ${pct(s.lowConfidenceRate)}`,
        `results           ok ${s.results.ok}, failed ${s.results.failed}, inconclusive ${s.results.inconclusive}, progressed ${s.results.progressed}`,
        `interrupts ${s.interrupts}, goals given up ${s.gaveUp}, crashes ${s.crashes}, deaths ${s.deaths}`,
    ].join('\n');
}
