import { expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('hiscores record the tick a level was reached, not the logout tick', () => {
    const dir = mkdtempSync(join(tmpdir(), 'level-playtime-'));
    try {
        mkdirSync(join(dir, 'data/config'), { recursive: true });
        copyFileSync(join(import.meta.dir, '../data/config/private.pem'), join(dir, 'data/config/private.pem'));
        copyFileSync(join(import.meta.dir, '../data/config/public.pem'), join(dir, 'data/config/public.pem'));
        const result = Bun.spawnSync([process.execPath, join(import.meta.dir, 'fixtures/level-playtime.ts')], {
            cwd: dir,
            env: { ...process.env, DB_BACKEND: 'sqlite', GE_ENABLED: 'false', BANK_TEST_CACHE: join(import.meta.dir, '../data/pack') },
            stdout: 'pipe', stderr: 'pipe'
        });
        if (result.exitCode !== 0) throw new Error(result.stdout.toString() + result.stderr.toString());
        expect(result.stdout.toString()).toContain('Level playtime checks passed');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
