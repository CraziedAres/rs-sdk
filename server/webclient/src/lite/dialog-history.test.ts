// A chat dialog that reopens on the same interface must be logged again.
//
// Mesboxes share a handful of interfaces (message1..message5) and each skill
// has one level-up interface, so "You don't have enough bars" twice in a row, or
// two Smithing level-ups, reuse a chatModalId. Dedup used to key on that id
// forever, so only the first ever reached recentDialogs.
//
// Needs no network: if no earlier suite loaded the cache, the interface baseline
// is stubbed with one synthetic text component.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import './dom-shim.js';

import IfType, { ComponentType } from '#/config/IfType.js';
import Packet from '#/io/Packet.js';

import { captureBaseInterfaces, resetBaseInterfaces } from './interfaces.js';
import { LiteClient } from './LiteClient.js';

const DIALOG_ID = 210;

function makeClient(name: string): LiteClient {
    return new LiteClient({
        connection: { out: Packet.alloc(1), isClosed: false } as never,
        locIndex: {} as never,
        username: name,
        password: 'x'
    });
}

let stubbedBase = false;

beforeAll(() => {
    try {
        makeClient('probe');
    } catch {
        IfType.list = [];
        IfType.list[DIALOG_ID] = new IfType();
        captureBaseInterfaces();
        stubbedBase = true;
    }
});

afterAll(() => {
    if (stubbedBase) {
        resetBaseInterfaces();
    }
});

describe('dialog history', () => {
    test('logs the same dialog interface again after it closes', () => {
        const c = makeClient('dialogs');
        const line = c.ifMutable(DIALOG_ID)!;
        line.type = ComponentType.TYPE_TEXT;
        line.text = "You don't have enough bronze bars to make a platebody.";

        c.chatModalId = DIALOG_ID;
        c.captureDialogToHistory();
        c.captureDialogToHistory(); // still open: not a second dialog
        expect(c.getDialogHistory().length).toBe(1);

        c.chatModalId = -1;
        c.captureDialogToHistory();
        c.chatModalId = DIALOG_ID;
        c.captureDialogToHistory();

        const history = c.getDialogHistory();
        expect(history.length).toBe(2);
        expect(history[0].text).toEqual(["You don't have enough bronze bars to make a platebody."]);
    });
});
