import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { EventEmitter } from 'node:events';

class TestWorker extends EventEmitter { postMessage() {} }
mock.module('worker_threads', () => ({ Worker: TestWorker }));
await import('../../src/engine/World.js');
const { default: InvType } = await import('../../src/cache/config/InvType.js');
const { default: ObjType } = await import('../../src/cache/config/ObjType.js');
const { default: VarPlayerType } = await import('../../src/cache/config/VarPlayerType.js');
const { default: Player } = await import('../../src/engine/entity/Player.js');
const { PlayerLoading } = await import('../../src/engine/entity/PlayerLoading.js');
const { PlayerStat } = await import('../../src/engine/entity/PlayerStat.js');
const { default: Packet } = await import('../../src/io/Packet.js');
const { updateHiscores } = await import('../../src/server/login/LoginServer.js');
const { db } = await import('../../src/db/query.js');
InvType.load(process.env.BANK_TEST_CACHE!);
ObjType.load(process.env.BANK_TEST_CACHE!);
VarPlayerType.load(process.env.BANK_TEST_CACHE!);

const database = new Database('db.sqlite');
database.exec('CREATE TABLE hiscore (account_id INTEGER, profile TEXT, type INTEGER, level INTEGER, value INTEGER, playtime INTEGER DEFAULT 0, date TEXT)');
database.exec('CREATE TABLE hiscore_large (account_id INTEGER, profile TEXT, type INTEGER, level INTEGER, value INTEGER, playtime INTEGER DEFAULT 0, date TEXT)');
database.exec('CREATE TABLE hiscore_outfit (account_id INTEGER, profile TEXT, value INTEGER, items TEXT, appearance TEXT, date TEXT)');
database.exec('CREATE TABLE hiscore_bank (account_id INTEGER, profile TEXT, value INTEGER, items TEXT, date TEXT)');
const account = { id: 1, staffmodlevel: 0, banned_until: null };
const row = (type: number) => database.query('SELECT level, playtime FROM hiscore WHERE account_id=1 AND type=?').get(type) as { level: number; playtime: number };
const total = () => database.query('SELECT level, playtime FROM hiscore_large WHERE account_id=1 AND type=0').get() as { level: number; playtime: number };
const reload = (player: InstanceType<typeof Player>) => PlayerLoading.load(player.username, new Packet(player.save(false)), null);

try {
    const player = reload(new Player('stamper', 1n, 1n));
    player.playtime = 1000;
    player.addXp(PlayerStat.WOODCUTTING, 10_000_000, false);
    assert.equal(player.levelPlaytime[PlayerStat.WOODCUTTING], 1000);
    player.playtime = 1500;
    player.addXp(PlayerStat.FISHING, 10_000_000, false);
    player.playtime = 9999; // keeps playing; logs out much later

    // The stamps survive a save round-trip and the boards record the level-up ticks, not logout.
    let saved = reload(player);
    assert.equal(saved.levelPlaytime[PlayerStat.WOODCUTTING], 1000);
    assert.equal(saved.levelPlaytime[PlayerStat.FISHING], 1500);
    await updateHiscores(account, saved, 'main');
    assert.equal(row(PlayerStat.WOODCUTTING + 1).playtime, 1000);
    assert.equal(row(PlayerStat.FISHING + 1).playtime, 1500);
    assert.equal(total().playtime, 1500);

    // XP without a level-up keeps the earlier stamps.
    player.playtime = 20000;
    player.addXp(PlayerStat.WOODCUTTING, 1, false);
    await updateHiscores(account, reload(player), 'main');
    assert.equal(row(PlayerStat.WOODCUTTING + 1).playtime, 1000);
    assert.equal(total().playtime, 1500);

    // Saves from before stamps existed fall back to logout playtime.
    const legacy = reload(new Player('legacy', 2n, 2n));
    legacy.baseLevels[PlayerStat.MINING] = 20;
    legacy.playtime = 4242;
    await updateHiscores({ ...account, id: 2 }, legacy, 'main');
    assert.equal((database.query('SELECT playtime FROM hiscore WHERE account_id=2 AND type=?').get(PlayerStat.MINING + 1) as { playtime: number }).playtime, 4242);
    assert.equal((database.query('SELECT playtime FROM hiscore_large WHERE account_id=2').get() as { playtime: number }).playtime, 4242);
    console.log('Level playtime checks passed');
} finally {
    database.close();
    await db.destroy();
}
// World imports initialize recurring timers; this isolated fixture has completed.
process.exit(0);
