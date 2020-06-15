import assert = require('assert');
import mocha = require('mocha');
const {describe, it} = mocha;

import {
    createChannel,
    Sendable,
    LocalFunctionName,
    H,
    LocalFunctionDefinition,
} from 'lwrpc';

async function assertRejects(fn: () => Promise<any>, expectedError?: string) {
    try {
        await fn();
        throw new Error('Did Not Reject');
    } catch (e) {
        if (expectedError !== undefined) {
            assert.equal(e, expectedError);
        }
    }
}

const preempt = async () => {};

type HalfChannel = {
    id: number;
    r: (m: any) => Promise<void>;
    c: () => Promise<void>;
    send: (m: any) => Promise<void>;
    registerReceive: (receive: (m: any) => void | Promise<void>) => void;
    registerClose: (close: () => void | Promise<void>) => void;
    other: HalfChannel;
    logging?: boolean;
};

let channelID = 1;
function createTestHalfChannel(logging: boolean): HalfChannel {
    const log = logging ? console.debug : (..._: any[]) => {};
    const cid = channelID++;
    const halfChannel: HalfChannel = {
        id: cid + 1000,
        async r(m: any) {
            log(halfChannel.id, 'LOST', m);
        },
        async c() {
            log(halfChannel.id, 'UNREGISTERED CLOSURE');
        },
        async send(m: any) {
            log(halfChannel.id, 'SEND', m);
            try {
                await halfChannel.other.r(m);
            } catch (e) {
                log(halfChannel.id, 'SEND-ERR', e);
            }
        },
        registerReceive(receive: (m: any) => void) {
            log(halfChannel.id, 'RECV REGISTERED');
            halfChannel.r = async (m: any) => {
                log(halfChannel.id, 'RECV', m);
                await preempt(); // allow preemption
                receive(m);
            };
        },
        registerClose(close: () => void) {
            log(halfChannel.id, 'CLOSE REGISTERED');
            halfChannel.c = async () => {
                log(halfChannel.id, 'CLOSE');
                await preempt(); // allow preemption
                close();
            };
        },
        other: undefined as any,
    };
    return halfChannel;
}

function createTestObjectChannel(logging: boolean = true) {
    const alpha = createTestHalfChannel(logging);
    const beta = createTestHalfChannel(logging);

    alpha.other = beta;
    beta.other = alpha;

    return {alpha, beta};
}

function createTestChannel(logging: boolean = true) {
    const {alpha, beta} = createTestObjectChannel(logging);

    alpha.logging = beta.logging = logging;

    const aC = createChannel(alpha);
    const bC = createChannel(beta);

    return {alpha: aC, beta: bC};
}

describe('TestChannel', () => {
    it('sends and receives data', async () => {
        const {alpha, beta} = createTestObjectChannel(false);

        const aR = new Promise((r) => {
            alpha.registerReceive(r);
        });
        const bR = new Promise((r) => {
            beta.registerReceive(r);
        });

        const aS = alpha.send(1);
        assert(1 === (await bR));
        await aS;

        const bS = beta.send(10);
        assert(10 === (await aR));
        await bS;
    });
});

const addDefinition: LocalFunctionDefinition = {
    name: 'add' as LocalFunctionName,
    args: [H.number, H.number],
    returns: H.number,
    fn(a, b) {
        return a + b;
    },
};

describe('lwrpc Channel', () => {
    it('can init', async () => {
        const _ = createTestChannel(false);
    });

    it('can publish, call, and return', async () => {
        const {alpha, beta} = createTestChannel(false);

        alpha.publish(addDefinition);
        beta.publish(addDefinition);

        await preempt();

        const aCall = alpha.add(3, 5);
        const bCall = beta.add(30, 50);

        assert.equal(await aCall, 8);
        assert.equal(await bCall, 80);
    });

    it('can wait for publication', async () => {
        const {alpha, beta} = createTestChannel(false);

        const aCall1 = alpha.add(1, 9);

        // make sure the expect message has been sent
        await preempt();

        beta.publish(addDefinition);

        assert.equal(await aCall1, 10);

        // the second call should not produce an expect message
        const aCall2 = alpha.add(2, 9);
        assert.equal(await aCall2, 11);
    });

    it('can differentiate multiple results', async () => {
        const {alpha, beta} = createTestChannel(false);

        alpha.publish(addDefinition);

        // we're not testing the 'expect' mechanism
        // so give the channels time to register the function before continuing
        await preempt();

        const b1 = beta.add(1, 2);
        const b2 = beta.add(3, 4);
        const b3 = beta.add(5, 6);
        const b4 = beta.add(7, 8);

        assert.equal(await b4, 15);
        assert.equal(await b3, 11);
        assert.equal(await b2, 7);
        assert.equal(await b1, 3);
    });

    describe('argument validation', () => {
        const noargs = {
            name: 'noargs' as LocalFunctionName,
            args: [] as Sendable[],
            returns: H.none,
            fn: async () => {},
        };

        const stringarg = {
            name: 'stringarg' as LocalFunctionName,
            args: [H.string],
            returns: H.none,
            fn: async () => {},
        };

        it('detects empty vs nonempty argument lists', async () => {
            const {alpha, beta} = createTestChannel(false);

            alpha.publish(noargs);
            alpha.publish(stringarg);

            await beta.noargs();
            await beta.stringarg('');

            await assertRejects(
                async () => await beta.noargs(''),
                'Invalid Arguments'
            );
            await assertRejects(
                async () => await beta.stringarg(),
                'Invalid Arguments'
            );
        });
    });

    describe('return validation', () => {
        it('detects incorrect return value types', async () => {
            const {alpha, beta} = createTestChannel(false);

            alpha.publish({
                name: 'fn1' as LocalFunctionName,
                args: [],
                returns: H.none,
                fn: async () => 1,
            });

            alpha.publish({
                name: 'fn2' as LocalFunctionName,
                args: [],
                returns: H.string,
                fn: async () => {},
            });

            await assertRejects(beta.fn1, 'invalid return value from rpc fn1');
            await assertRejects(beta.fn2, 'invalid return value from rpc fn2');
        });
    });
});
