// @ts-check
// Saving and restoring the decision layer's state, so that an agent restart is a hiccup rather than amnesia.
// Mindcraft restarts the agent process whenever an action refuses to stop within 10 s or the unstuck mode gives
// up; without this every restart forgot which goals had failed, what had been banned and what had been spent.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const STATE_VERSION = 1;

/**
 * Write JSON so that a crash mid-write never leaves a half-written file: write aside, then rename over.
 * @param {string} path
 * @param {unknown} data
 */
export function saveJSON(path, data) {
    mkdirSync(dirname(path), { recursive: true });
    const aside = `${path}.${process.pid}.tmp`;
    writeFileSync(aside, JSON.stringify(data));
    renameSync(aside, path);
}

/**
 * @param {string} path
 * @returns {any | null} the parsed file, or null if it is missing or unreadable
 */
export function loadJSON(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * A short, stable fingerprint of what the profile asks for, to tell whether a saved goal queue still applies.
 * @param {unknown} value
 */
export function fingerprint(value) {
    return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 16);
}
