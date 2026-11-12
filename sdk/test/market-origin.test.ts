import { describe, expect, test } from 'bun:test';
import { BotSDK, deriveMarketOrigin } from '../index';

// Market reads go to the game's web server. A gateway URL on the gateway's own port has no market API.
describe('deriveMarketOrigin', () => {
    const direct = { 'wss://game.example/gateway': 'wss://game.example:7443' };
    test('a direct gateway URL maps back to the relayed one, whose origin is the game', () => {
        expect(deriveMarketOrigin('wss://game.example:7443', '', '', direct)).toBe('https://game.example');
    });
    test('the relayed gateway path and a plain remote host keep their origin', () => {
        expect(deriveMarketOrigin('wss://game.example/gateway', '', '', direct)).toBe('https://game.example');
        expect(deriveMarketOrigin('wss://other.example:9443/gateway', '', '', direct)).toBe('https://other.example:9443');
    });
    test('an unknown remote gateway on its own port is not the web server: the default port is', () => {
        expect(deriveMarketOrigin('wss://other.example:7443', '', '', direct)).toBe('https://other.example');
    });
    test('local gateways use the local game port; explicit origins and the browser URL win', () => {
        expect(deriveMarketOrigin('ws://localhost:7780')).toBe('http://localhost:8888');
        expect(deriveMarketOrigin('wss://game.example:7443', 'https://web.example/bot?bot=x&password=y', '', direct)).toBe('https://web.example');
        expect(deriveMarketOrigin('wss://game.example:7443', 'https://web.example/bot', 'http://localhost:9999/anything', direct)).toBe('http://localhost:9999');
    });
    test('BotSDK uses it for market reads, never the gateway port', () => {
        const sdk = new BotSDK({ botUsername: 'unused', gatewayUrl: 'wss://rs-sdk-demo.fly.dev:7443', autoLaunchBrowser: false });
        expect(sdk.marketOrigin()).toBe('https://rs-sdk-demo.fly.dev');
        const pinned = new BotSDK({ botUsername: 'unused', gatewayUrl: 'wss://rs-sdk-demo.fly.dev:7443', marketOrigin: 'http://localhost:8888', autoLaunchBrowser: false });
        expect(pinned.marketOrigin()).toBe('http://localhost:8888');
    });
});
