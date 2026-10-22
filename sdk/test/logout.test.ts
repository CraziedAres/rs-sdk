import { describe, expect, test } from 'bun:test';
import { BotActions } from '../actions';
import { BotSDK } from '../index';

type ServerReply = 'detach' | 'out_of_game' | 'status_dead' | 'combat' | 'duel' | 'nothing' | 'bot_not_connected';

/**
 * A fake SDK whose server answers the logout click one way. Ticks are 1 ms
 * (ticksToMs is the identity), so timeouts are quick.
 */
function createBot(reply: ServerReply, options: { inGame?: boolean; detached?: boolean } = {}) {
    const clicks: number[] = [];
    const detachListeners = new Set<() => void>();
    let detached = options.detached ?? false;
    let stateAge = 0;
    let statusDead = false;
    const state: any = {
        tick: 100,
        inGame: options.inGame ?? true,
        dialog: { isOpen: false, options: [] },
        interface: { isOpen: false, interfaceId: -1 },
        shop: { isOpen: false },
        bank: { isOpen: false },
        gameMessages: [{ type: 0, text: "You can't log out until 10 seconds after the end of combat.", sender: '', tick: 50 }],
    };
    const sdk = {
        getState: () => state,
        ticksToMs: (ticks: number) => ticks,
        getStateAge: () => stateAge,
        isClientDetached: () => detached,
        onClientDetached: (listener: () => void) => {
            detachListeners.add(listener);
            return () => detachListeners.delete(listener);
        },
        checkBotStatus: async () => ({ status: statusDead ? 'dead' : 'active', inGame: !statusDead }),
        waitForStateChange: async (timeout: number) => {
            await Bun.sleep(Math.max(1, Math.min(timeout, 2)));
            return state;
        },
        sendClickComponent: async (componentId: number) => {
            clicks.push(componentId);
            if (reply === 'bot_not_connected') return { success: false, message: 'Bot not connected' };
            setTimeout(() => {
                if (reply === 'detach') {
                    detached = true;
                    for (const listener of detachListeners) listener();
                } else if (reply === 'out_of_game') {
                    state.inGame = false;
                } else if (reply === 'status_dead') {
                    // State stops arriving and the gateway's notice is missed
                    stateAge = 1_000;
                    statusDead = true;
                } else if (reply === 'combat' || reply === 'duel') {
                    const text = reply === 'combat'
                        ? "You can't log out until 10 seconds after the end of combat."
                        : "You can't log out during a duel.";
                    state.gameMessages = [...state.gameMessages, { type: 0, text, sender: '', tick: 102 }];
                }
            }, 3);
            return { success: true, message: 'Clicked component 2458' };
        },
    };
    return { bot: new BotActions(sdk as any), clicks, detachListeners };
}

describe('BotActions.logout', () => {
    test('clicks the logout button and succeeds when the game client leaves', async () => {
        const { bot, clicks, detachListeners } = createBot('detach');
        const result = await bot.logout();
        expect(result.success).toBe(true);
        expect(result.reason).toBeUndefined();
        expect(clicks).toEqual([2458]);
        expect(detachListeners.size).toBe(0);
    });

    test('succeeds when the client reports it is out of game (browser client)', async () => {
        const result = await createBot('out_of_game').bot.logout();
        expect(result.success).toBe(true);
    });

    test("falls back to the gateway's status once state stops arriving", async () => {
        const result = await createBot('status_dead').bot.logout({ timeoutTicks: 200 });
        expect(result.success).toBe(true);
        expect(result.message).toContain('gateway');
    });

    test('a combat refusal after the click is in_combat; one from before the click is ignored', async () => {
        const result = await createBot('combat').bot.logout();
        expect(result).toEqual({
            success: false,
            message: "You can't log out until 10 seconds after the end of combat.",
            reason: 'in_combat',
        });
    });

    test('other refusals carry the server message and no reason', async () => {
        const result = await createBot('duel').bot.logout();
        expect(result.success).toBe(false);
        expect(result.reason).toBeUndefined();
        expect(result.message).toBe("You can't log out during a duel.");
    });

    test('times out when the session is not seen to end', async () => {
        const result = await createBot('nothing').bot.logout({ timeoutTicks: 20 });
        expect(result.success).toBe(false);
        expect(result.reason).toBe('timeout');
    });

    test('not_logged_in without a game session, and nothing is clicked', async () => {
        const outOfGame = createBot('detach', { inGame: false });
        expect((await outOfGame.bot.logout()).reason).toBe('not_logged_in');
        expect(outOfGame.clicks).toEqual([]);

        // After a logout the last state still says inGame, but the client has gone
        const detached = createBot('detach', { detached: true });
        expect((await detached.bot.logout()).reason).toBe('not_logged_in');
        expect(detached.clicks).toEqual([]);

        const noClient = createBot('bot_not_connected');
        expect((await noClient.bot.logout()).reason).toBe('not_logged_in');
    });
});

describe('BotSDK client detach', () => {
    test("the gateway's 'Bot disconnected' marks the client detached until state arrives again", () => {
        const sdk = new BotSDK({ botUsername: 'test', password: 'test', autoLaunchBrowser: false });
        const handle = (sdk as any).handleMessage.bind(sdk);
        let notices = 0;
        const unsubscribe = sdk.onClientDetached(() => notices++);

        handle(JSON.stringify({ type: 'sdk_state', state: { tick: 1, inGame: true, skills: [] } }));
        expect(sdk.isClientDetached()).toBe(false);

        handle(JSON.stringify({ type: 'sdk_error', error: 'Bot disconnected' }));
        expect(sdk.isClientDetached()).toBe(true);
        expect(notices).toBe(1);

        // Other errors are not a detach
        handle(JSON.stringify({ type: 'sdk_error', error: 'Bot not connected' }));
        expect(notices).toBe(1);

        handle(JSON.stringify({ type: 'sdk_state', state: { tick: 2, inGame: true, skills: [] } }));
        expect(sdk.isClientDetached()).toBe(false);

        unsubscribe();
        handle(JSON.stringify({ type: 'sdk_error', error: 'Bot disconnected' }));
        expect(notices).toBe(1);
    });
});
