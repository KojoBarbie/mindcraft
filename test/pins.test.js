// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'));

// patches/<name>+<version>.patch (scoped packages use "+" instead of "/")
const patches = readdirSync(new URL('patches/', root))
    .filter(f => f.endsWith('.patch'))
    .map(f => {
        const parts = f.replace(/\.patch$/, '').split('+');
        const version = parts.pop();
        return { file: f, name: parts.join('/'), version };
    });

// minecraft-data's patch only touches data files that are stable across versions and applies to newer
// releases; mineflayer needs a newer minecraft-data than the patch was cut from, so it is not pinned.
const VERSION_DRIFT_ALLOWED = new Set(['minecraft-data']);

test('there are patches to check', () => {
    assert.ok(patches.length > 0);
});

for (const patch of patches) {
    if (VERSION_DRIFT_ALLOWED.has(patch.name)) continue;

    test(`lockfile resolves ${patch.name} to the patched version ${patch.version}`, () => {
        const entry = lock.packages[`node_modules/${patch.name}`];
        assert.ok(entry, `${patch.name} is missing from package-lock.json`);
        assert.equal(entry.version, patch.version, `${patch.file} would not apply`);
    });

    if (pkg.dependencies[patch.name]) {
        test(`package.json pins ${patch.name} exactly`, () => {
            assert.equal(pkg.dependencies[patch.name], patch.version);
        });
    }
}
