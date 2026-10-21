// Animations must expire, not stick.
//
// The lite client sets primaryAnim/spotanimId from update masks; without aging,
// the first animation of a session leaves `animId !== -1` true forever, and
// every SDK check that gates "did my action start" / "am I idle" on animId is
// poisoned. LiteClient.ageAnims (run from tickCycle, one step per ~20ms cycle,
// the same cadence as the browser's entityAnim) retires them.
//
// Needs no network: SeqType/SpotType entries are synthesised at high ids and the
// interface baseline is stubbed empty when no earlier suite loaded the cache.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import './dom-shim.js';

import IfType from '#/config/IfType.js';
import SeqType, { RestartMode } from '#/config/SeqType.js';
import SpotType from '#/config/SpotType.js';
import ClientNpc from '#/dash3d/ClientNpc.js';
import Packet from '#/io/Packet.js';
import { ServerProt } from '#/io/ServerProt.js';

import { captureBaseInterfaces, resetBaseInterfaces } from './interfaces.js';
import { LiteClient } from './LiteClient.js';
import { applyAnimMask } from './protocol/entities.js';
import { dispatch } from './protocol/incoming.js';

/** A LiteClient with no socket: nothing below touches the connection. */
function makeClient(name: string): LiteClient {
    return new LiteClient({
        connection: { out: Packet.alloc(1), isClosed: false } as never,
        locIndex: {} as never,
        username: name,
        password: 'x'
    });
}

// InterfaceTable needs a captured baseline. If another suite already loaded the
// real cache, use it; otherwise stub an empty table and put things back for any
// suite that loads the real cache later in this process.
let stubbedBase = false;
let savedSeqLen = 0;
let savedSpotLen = 0;

beforeAll(() => {
    try {
        makeClient('probe');
    } catch {
        IfType.list = [];
        captureBaseInterfaces();
        stubbedBase = true;
    }
    savedSeqLen = SeqType.list.length;
    savedSpotLen = SpotType.list.length;
});

afterAll(() => {
    SeqType.list.length = savedSeqLen;
    SpotType.list.length = savedSpotLen;
    if (stubbedBase) {
        resetBaseInterfaces();
    }
});

/** Synthesise a SeqType at a high id no real cache reaches. */
function defineSeq(id: number, delays: number[], opts: { loops?: number; maxloops?: number; duplicatebehaviour?: number } = {}): void {
    const seq = new SeqType();
    seq.numFrames = delays.length;
    seq.frames = new Int16Array(delays.length).fill(-1);
    seq.iframes = new Int16Array(delays.length).fill(-1);
    seq.delay = new Int16Array(delays);
    if (opts.loops !== undefined) seq.loops = opts.loops;
    if (opts.maxloops !== undefined) seq.maxloops = opts.maxloops;
    if (opts.duplicatebehaviour !== undefined) seq.duplicatebehaviour = opts.duplicatebehaviour;
    SeqType.list[id] = seq;
}

const SEQ_ONESHOT = 61001; // delays [3,3], plays once: expires on the 7th cycle
const SEQ_RESET = 61002; // same timing, duplicatebehaviour RESET
const SEQ_LOOP = 61003; // delays [2,2], loops=1: replays last frame ~99 times
const SPOT_ID = 61004;

/** Attach a visible npc so the aging loop (which walks npcIds) reaches it. */
function visibleNpc(c: LiteClient, index = 7): ClientNpc {
    const npc = new ClientNpc();
    c.npc[index] = npc;
    c.npcIds[0] = index;
    c.npcCount = 1;
    return npc;
}

describe('animation expiry', () => {
    test('a finite anim reads -1 after its frame delays elapse, with no further packets', () => {
        defineSeq(SEQ_ONESHOT, [3, 3]);
        const c = makeClient('bota');
        const npc = visibleNpc(c);

        applyAnimMask(npc, SEQ_ONESHOT, 0);
        expect(npc.primaryAnim).toBe(SEQ_ONESHOT);

        // Two frames, delay 3 each: frame f advances when the accumulated cycle
        // exceeds its delay, i.e. after delay+1 steps - 4 cycles for frame 0,
        // then 3 more to overrun frame 1 (its residue carries over) = 7 total.
        for (let i = 0; i < 6; i++) {
            c.tickCycle();
            expect(npc.primaryAnim).toBe(SEQ_ONESHOT);
        }
        c.tickCycle();
        expect(npc.primaryAnim).toBe(-1);
    });

    test('the ANIM start delay postpones expiry by the same number of cycles', () => {
        defineSeq(SEQ_ONESHOT, [3, 3]);
        const c = makeClient('botb');
        const npc = visibleNpc(c);

        applyAnimMask(npc, SEQ_ONESHOT, 2);
        for (let i = 0; i < 8; i++) {
            c.tickCycle();
        }
        expect(npc.primaryAnim).toBe(SEQ_ONESHOT); // 2 held + 6 playing
        c.tickCycle();
        expect(npc.primaryAnim).toBe(-1);
    });

    test('a re-trigger (duplicatebehaviour RESET) restarts the clock', () => {
        defineSeq(SEQ_RESET, [3, 3], { duplicatebehaviour: RestartMode.RESET });
        const c = makeClient('botc');
        const npc = visibleNpc(c);

        applyAnimMask(npc, SEQ_RESET, 0);
        for (let i = 0; i < 4; i++) {
            c.tickCycle();
        }
        expect(npc.primaryAnim).toBe(SEQ_RESET);

        // Re-triggered mid-play, the way combat anims land every attack.
        applyAnimMask(npc, SEQ_RESET, 0);
        expect(npc.primaryAnimFrame).toBe(0);
        for (let i = 0; i < 6; i++) {
            c.tickCycle();
            expect(npc.primaryAnim).toBe(SEQ_RESET);
        }
        c.tickCycle();
        expect(npc.primaryAnim).toBe(-1);

        // And once expired, the next mask starts it fresh.
        applyAnimMask(npc, SEQ_RESET, 0);
        expect(npc.primaryAnim).toBe(SEQ_RESET);
    });

    test('a looping seq (replayoff set) keeps playing rather than flapping', () => {
        defineSeq(SEQ_LOOP, [2, 2], { loops: 1, maxloops: 99 });
        const c = makeClient('botd');
        const npc = visibleNpc(c);

        applyAnimMask(npc, SEQ_LOOP, 0);
        for (let i = 0; i < 50; i++) {
            c.tickCycle();
            expect(npc.primaryAnim).toBe(SEQ_LOOP);
        }

        // ...but still terminates once maxloops replays are done, as the
        // browser's would (maxloops defaults to 99, never infinity).
        for (let i = 0; i < 400; i++) {
            c.tickCycle();
        }
        expect(npc.primaryAnim).toBe(-1);
    });

    test('the local player ages too', () => {
        defineSeq(SEQ_ONESHOT, [3, 3]);
        const c = makeClient('bote');
        applyAnimMask(c.localPlayer!, SEQ_ONESHOT, 0);
        for (let i = 0; i < 7; i++) {
            c.tickCycle();
        }
        expect(c.localPlayer!.primaryAnim).toBe(-1);
    });

    test('spotanim expires after its flight delay plus its seq duration', () => {
        defineSeq(SEQ_ONESHOT, [3, 3]);
        const spot = new SpotType();
        spot.seq = SeqType.list[SEQ_ONESHOT];
        SpotType.list[SPOT_ID] = spot;

        const c = makeClient('botf');
        const npc = visibleNpc(c);

        // What the SPOTANIM update mask writes, with zero height/delay.
        npc.spotanimId = SPOT_ID;
        npc.spotanimLastCycle = c.cycle.value;
        npc.spotanimFrame = 0;
        npc.spotanimCycle = 0;

        for (let i = 0; i < 6; i++) {
            c.tickCycle();
            expect(npc.spotanimId).toBe(SPOT_ID);
        }
        c.tickCycle();
        expect(npc.spotanimId).toBe(-1);
    });

    test('RESET_ANIMS still clears everything at once', () => {
        defineSeq(SEQ_LOOP, [2, 2], { loops: 1, maxloops: 99 });
        const c = makeClient('botg');
        const npc = visibleNpc(c);

        applyAnimMask(npc, SEQ_LOOP, 0);
        applyAnimMask(c.localPlayer!, SEQ_LOOP, 0);
        c.tickCycle();
        expect(npc.primaryAnim).toBe(SEQ_LOOP);

        const empty = Packet.alloc(1);
        dispatch(c, ServerProt.RESET_ANIMS, empty, 0);
        expect(npc.primaryAnim).toBe(-1);
        expect(c.localPlayer!.primaryAnim).toBe(-1);
    });
});

// animId alone can't tell a fresh action from the previous one still playing,
// so StateCollector publishes when the server last (re)sent an animation.
describe('animation starts', () => {
    test('every start or re-send counts, a stop or a lost priority contest does not', () => {
        defineSeq(SEQ_LOOP, [2, 2], { loops: 1, maxloops: 99 });
        defineSeq(SEQ_ONESHOT, [3, 3]);
        SeqType.list[SEQ_LOOP].priority = 5;
        SeqType.list[SEQ_ONESHOT].priority = 1;
        const npc = new ClientNpc();

        applyAnimMask(npc, SEQ_LOOP, 0);
        expect(npc.primaryAnimStarts).toBe(1);
        applyAnimMask(npc, SEQ_LOOP, 0); // same anim re-sent while still playing
        expect(npc.primaryAnimStarts).toBe(2);
        applyAnimMask(npc, SEQ_ONESHOT, 0); // lower priority: not shown
        expect(npc.primaryAnim).toBe(SEQ_LOOP);
        expect(npc.primaryAnimStarts).toBe(2);
        applyAnimMask(npc, -1, 0);
        expect(npc.primaryAnimStarts).toBe(2);
    });
});
