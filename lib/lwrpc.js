"use strict";
// lwrpc
// light weight remote procedure calls
// there are a few bits to this
// call createChannel(channelParams) to create an lwrpc channel
// call channel.publish(fdef) to send a function definition to the other side
// call await channel.fname(...) to call a published function
//
// the send and registerReceive parameters for the channel mustprovide the following:
//  if you call send on one side with a plain-old-javascript-object
//  receive will be called on the other side with a plain-old-javascript-object
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWebSocketChannel = exports.createChannel = exports.H = void 0;
exports.H = {
    none: 0,
    string: 1,
    number: 2,
    boolean: 3,
    array: (valueType) => ({ $c: 4, $v: valueType }),
    object: (keyType, valueType) => ({ $c: 5, $k: keyType, $v: valueType }),
    union: (...unionTypes) => ({ $c: 6, $t: unionTypes }),
};
function createChannel(params) {
    const send = params.send;
    const registerReceive = params.registerReceive;
    const { registerClose } = params;
    const { publish } = params;
    let open = true;
    let counter = 1;
    const remoteFunctions = {};
    const inFlight = {};
    const published = {};
    const expected = {}; // functions we expect to be published
    const log = isBool(params.logging) ?
        (params.logging ? console.debug : () => { }) :
        (params.logging ? params.logging : () => { });
    const sendFunction = (lfd) => {
        const { name, args, returns } = lfd;
        send({
            type: 'publish',
            name: name,
            args,
            returns,
        });
    };
    const publishFunction = (lfd) => {
        const { name } = lfd;
        if (published.hasOwnProperty(name)) {
            throw new Error('channel already has a published function called ' + name);
        }
        // send the function definition to the other side
        published[name] = lfd;
        sendFunction(lfd);
    };
    registerReceive(async (m) => {
        switch (m.type) {
            case 'call':
                {
                    const { name, nonce, args } = m;
                    if (!published.hasOwnProperty(name)) {
                        log('call to unpublished function', m);
                        send({ type: 'error', nonce, message: `Unpublished Function: ${name}` });
                    }
                    else
                        try {
                            const { fn, args: argstype } = published[name];
                            if (validate(args, argstype)) {
                                let result = await fn(...args);
                                if (result === undefined || typeof result === 'undefined')
                                    result = null;
                                if (open)
                                    send({ type: 'result', nonce, value: result });
                            }
                            else {
                                log('Invalid Incoming Arguments', args, argstype);
                                send({ type: 'error', nonce, message: 'Invalid Arguments' });
                            }
                        }
                        catch (e) {
                            send({ type: 'error', nonce, message: 'Exception: ' + e.toString() });
                        }
                }
                break;
            case 'publish':
                {
                    log('Received Published Function', m);
                    const { name, returns } = m;
                    if (remoteFunctions.hasOwnProperty(name)) {
                        log(`published function ${name} already exists`);
                        // send({type: 'error', nonce: -1, message: `Double Published Function ${name}`})
                    }
                    else {
                        remoteFunctions[name] = async (...callArgs) => {
                            const nonce = counter++;
                            send({
                                type: 'call',
                                nonce,
                                name,
                                args: callArgs,
                            });
                            return await new Promise((resolve, fail) => {
                                inFlight[nonce] = { name, returns, resolve, fail };
                            });
                        };
                        if (name in expected) {
                            log(`expected published function ${name} for ${expected[name].length} call(s)`);
                            expected[name].map(resolve => resolve());
                        }
                    }
                }
                break;
            case 'expect':
                {
                    log('received expect message', m.name);
                    const { name } = m;
                    if (name in published) {
                        sendFunction(published[name]);
                    }
                    else {
                        log('expected function not yet published: ', name);
                    }
                }
                break;
            case 'error':
                {
                    log('received error message', m);
                    const { nonce, message } = m;
                    if (inFlight.hasOwnProperty(nonce)) {
                        inFlight[nonce].fail(message);
                        delete inFlight[nonce];
                    }
                    else {
                        log('Error Message', m);
                    }
                }
                break;
            case 'result':
                {
                    const { nonce, value } = m;
                    if (inFlight.hasOwnProperty(nonce)) {
                        const rpc = inFlight[nonce];
                        if (!validate(value, rpc.returns))
                            rpc.fail(`invalid return value from rpc ${rpc.name}`);
                        else
                            rpc.resolve(value);
                        delete inFlight[nonce];
                    }
                    else {
                        log('Result for invalid nonce', m);
                    }
                }
                break;
        }
    });
    registerClose(() => {
        open = false;
        for (const k of Object.keys(inFlight)) {
            inFlight[k].fail('Connection Closed');
            delete inFlight[k];
        }
        for (const k of Object.keys(remoteFunctions)) {
            remoteFunctions[k] = async () => {
                log('Calling function after connection closed', k);
            };
        }
    });
    if (publish)
        for (const rfd of publish)
            publishFunction(rfd);
    return new Proxy({}, {
        get(_t, prop, _r) {
            if (prop === 'publish') {
                return publishFunction;
            }
            else if (!(prop in remoteFunctions)) {
                log(prop, 'not in remote functions', ...Object.keys(remoteFunctions));
                return async (...args) => {
                    await new Promise(resolve => {
                        if (prop in expected) {
                            expected[prop].push(resolve);
                        }
                        else {
                            expected[prop] = [resolve];
                        }
                    });
                    send({ type: 'expect', name: prop });
                    return await remoteFunctions[prop](...args);
                };
            }
            else {
                return remoteFunctions[prop];
            }
        }
    });
}
exports.createChannel = createChannel;
async function createWebSocketChannel(ws, publish) {
    if (ws.readyState !== 1) {
        if (ws.readyState !== 0) {
            throw new Error('web socket already closed');
        }
        else {
            await new Promise((r, f) => {
                ws.addEventListener('open', r);
                ws.addEventListener('error', f);
            });
        }
    }
    return createChannel({
        send: (o) => ws.send(JSON.stringify(o)),
        registerReceive(receive) {
            ws.addEventListener('message', (o) => receive(JSON.parse(o)));
        },
        registerClose(close) {
            ws.addEventListener('close', close);
        },
        publish,
    });
}
exports.createWebSocketChannel = createWebSocketChannel;
function validate(value, type) {
    if (isNumber(type)) {
        // basic type
        switch (type) {
            case 0: return value === null;
            case 1: return isString(value);
            case 2: return isNumber(value);
            case 3: return isBool(value);
            default: return false;
        }
    }
    else if (isArray(type)) {
        // fixed structure array
        if (isArray(value)) {
            return (type.length === value.length) &&
                value.map((v, i) => [v, type[i]])
                    .every(([v, t]) => validate(v, t));
        }
        else {
            return false;
        }
    }
    else if (isObject(type)) {
        if (type.hasOwnProperty('$c')) {
            if (isArray(value) && type.$c === 4) {
                // variable structure array
                return value.every(v => validate(v, type.$v));
            }
            else if (type.$c === 5 && isObject(value)) {
                // variable structure object
                return Object.keys(value).every(k => validate(k, type.$k)) &&
                    Object.values(value).every(v => validate(v, type.$v));
            }
            else if (type.$c === 6) {
                // typed union
                return Object.values(type.$t).some(t => validate(value, t));
            }
            else {
                return false;
            }
        }
        else {
            // fixed structure object
            const vres = value;
            const tres = type;
            // must have same keys
            // keys must have the right types
            return (Object.keys(type).every(k => value.hasOwnProperty(k)) &&
                Object.keys(value).every(k => type.hasOwnProperty(k)) &&
                Object.keys(value).every(k => validate(vres[k], tres[k])));
        }
    }
    else {
        // log('could not resolve type', type, value);
        return false;
    }
}
const isArray = Array.isArray;
const isString = (x) => typeof x === 'string';
const isNumber = (x) => typeof x === 'number';
const isBool = (x) => typeof x === 'boolean';
const isObject = (x) => typeof x === 'object' && !isArray(x);
//# sourceMappingURL=lwrpc.js.map