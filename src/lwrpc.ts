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

type subtype<parent, label> = parent & {_: label};
type RemoteFunctionName = subtype<string, 'remote_function_name'>;
export type LocalFunctionName = subtype<string, 'published_function_name'>;
type AnyFunctionName = RemoteFunctionName & LocalFunctionName;

export type Sendable =
    | 0 // none
    | 1 // string
    | 2 // number
    | 3 // boolean
    | VariableStructureArraySendable // variable structure array
    | VariableStructureObjectSendable // variable structure object
    | UnionSendable // union type
    | Sendable[] // fixed structure array
    | {[key: string]: Sendable}; // fixed structure object

type VariableStructureArraySendable = {$c: 4; $v: Sendable};
type VariableStructureObjectSendable = {$c: 5; $k: 1 | 2; $v: Sendable};
type UnionSendable = {$c: 6; $t: Sendable[]};

type SendableHelper = {
    none: 0;
    string: 1;
    number: 2;
    boolean: 3;
    array: (v: Sendable) => VariableStructureArraySendable;
    object: (k: 1 | 2, v: Sendable) => VariableStructureObjectSendable;
    union: (...u: Sendable[]) => UnionSendable;
};

export const H: SendableHelper = {
    none: 0,
    string: 1,
    number: 2,
    boolean: 3,
    array: (valueType: Sendable) => ({$c: 4, $v: valueType}),
    object: (keyType: 1 | 2, valueType: Sendable) => ({
        $c: 5,
        $k: keyType,
        $v: valueType,
    }),
    union: (...unionTypes: Sendable[]) => ({$c: 6, $t: unionTypes}),
};

export type LocalFunction = (...args: any[]) => Promise<any>;

export type LocalFunctionDefinition = {
    name: LocalFunctionName;
    args: Sendable[];
    returns: Sendable;
    fn: LocalFunction;
};

export type RemoteFunctionDefinition = {
    name: RemoteFunctionName;
    args: Sendable[];
    returns: Sendable;
};

export type ChannelParams = {
    send: (o: any) => void;
    registerReceive: (receive: (o: any) => Promise<void>) => void;
    registerClose: (close: () => void) => void;
    publish?: LocalFunctionDefinition[];
    logging?: boolean | ((...args: any[]) => void);
};

type Message =
    | {
          type: 'publish';
          name: AnyFunctionName;
          args: Sendable;
          returns: Sendable;
      }
    | {
          type: 'call';
          nonce: number;
          name: RemoteFunctionName;
          args: any;
      }
    | {
          type: 'result';
          nonce: number;
          value: any;
      }
    | {
          type: 'error'; // a function call failed for some reason
          nonce: number;
          message: string;
      }
    | {
          type: 'expect'; // a request for a function that may have already been published
          name: AnyFunctionName;
      };

type InFlightRPC = {
    name: RemoteFunctionName;
    returns: Sendable;
    resolve: (...args: any) => void;
    fail: (...args: any) => void;
};

type Channel = {publish: (rfd: LocalFunctionDefinition) => void} & {
    [key: string]: (...args: any) => Promise<any>;
};

export function createChannel(params: ChannelParams): Channel {
    const send: (o: Message) => void = params.send;
    const registerReceive: (r: (o: Message) => Promise<void>) => void =
        params.registerReceive;
    const {registerClose} = params;
    const {publish} = params;

    let open = true;
    let counter = 1;
    const remoteFunctions: {[key: string]: (...a: any[]) => Promise<any>} = {};
    const inFlight: {[key: number]: InFlightRPC} = {};
    const published: {[key: string]: LocalFunctionDefinition} = {};
    const expected: {[key: string]: (() => void)[]} = {}; // functions we expect to be published

    const log = isBool(params.logging)
        ? params.logging
            ? console.debug
            : () => {}
        : params.logging
        ? params.logging
        : () => {};

    const sendFunction = (lfd: LocalFunctionDefinition): void => {
        const {name, args, returns} = lfd;

        send({
            type: 'publish',
            name: name as AnyFunctionName,
            args,
            returns,
        });
    };

    const publishFunction = (lfd: LocalFunctionDefinition): void => {
        const {name} = lfd;
        if (published.hasOwnProperty(name)) {
            throw new Error(
                'channel already has a published function called ' + name
            );
        }

        // send the function definition to the other side
        published[name] = lfd as LocalFunctionDefinition;
        sendFunction(lfd);
    };

    registerReceive(async (m: Message) => {
        switch (m.type) {
            case 'call':
                {
                    const {name, nonce, args} = m;
                    if (!published.hasOwnProperty(name)) {
                        log('call to unpublished function', m);
                        send({
                            type: 'error',
                            nonce,
                            message: `Unpublished Function: ${name}`,
                        });
                    } else
                        try {
                            const {fn, args: argstype} = published[name];
                            if (validate(args, argstype)) {
                                let result = await fn(...args);
                                if (
                                    result === undefined ||
                                    typeof result === 'undefined'
                                )
                                    result = null;
                                if (open)
                                    send({
                                        type: 'result',
                                        nonce,
                                        value: result,
                                    });
                            } else {
                                log(
                                    'Invalid Incoming Arguments',
                                    args,
                                    argstype
                                );
                                send({
                                    type: 'error',
                                    nonce,
                                    message: 'Invalid Arguments',
                                });
                            }
                        } catch (e) {
                            send({
                                type: 'error',
                                nonce,
                                message: 'Exception: ' + e.toString(),
                            });
                        }
                }
                break;
            case 'publish':
                {
                    log('Received Published Function', m);
                    const {name, returns} = m;
                    if (remoteFunctions.hasOwnProperty(name)) {
                        log(`published function ${name} already exists`);
                        // send({type: 'error', nonce: -1, message: `Double Published Function ${name}`})
                    } else {
                        remoteFunctions[name] = async (...callArgs) => {
                            const nonce = counter++;

                            send({
                                type: 'call',
                                nonce,
                                name,
                                args: callArgs,
                            });

                            return await new Promise((resolve, fail) => {
                                inFlight[nonce] = {
                                    name,
                                    returns,
                                    resolve,
                                    fail,
                                };
                            });
                        };

                        if (name in expected) {
                            log(
                                `expected published function ${name} for ${expected[name].length} call(s)`
                            );
                            expected[name].map((resolve) => resolve());
                        }
                    }
                }
                break;
            case 'expect':
                {
                    log('received expect message', m.name);
                    const {name} = m;
                    if (name in published) {
                        sendFunction(published[name]);
                    } else {
                        log('expected function not yet published: ', name);
                    }
                }
                break;
            case 'error':
                {
                    log('received error message', m);
                    const {nonce, message} = m;
                    if (inFlight.hasOwnProperty(nonce)) {
                        inFlight[nonce].fail(message);
                        delete inFlight[nonce];
                    } else {
                        log('Error Message', m);
                    }
                }
                break;
            case 'result':
                {
                    const {nonce, value} = m;
                    if (inFlight.hasOwnProperty(nonce)) {
                        const rpc = inFlight[nonce];
                        if (!validate(value, rpc.returns))
                            rpc.fail(
                                `invalid return value from rpc ${rpc.name}`
                            );
                        else rpc.resolve(value);
                        delete inFlight[nonce];
                    } else {
                        log('Result for invalid nonce', m);
                    }
                }
                break;
        }
    });

    registerClose(() => {
        open = false;

        for (const k of Object.keys(inFlight) as any) {
            inFlight[k].fail('Connection Closed');
            delete inFlight[k];
        }

        for (const k of Object.keys(remoteFunctions)) {
            remoteFunctions[k] = async () => {
                log('Calling function after connection closed', k);
            };
        }
    });

    if (publish) for (const rfd of publish) publishFunction(rfd);

    return new Proxy(
        {},
        {
            get(_t: any, prop: string, _r: any) {
                if (prop === 'publish') {
                    return publishFunction;
                } else if (!(prop in remoteFunctions)) {
                    log(
                        prop,
                        'not in remote functions',
                        ...Object.keys(remoteFunctions)
                    );
                    return async (...args: any[]) => {
                        await new Promise((resolve) => {
                            if (prop in expected) {
                                expected[prop].push(resolve);
                            } else {
                                expected[prop] = [resolve];
                            }
                        });

                        send({type: 'expect', name: prop as AnyFunctionName});

                        return await remoteFunctions[prop](...args);
                    };
                } else {
                    return remoteFunctions[prop];
                }
            },
        }
    );
}

export async function createWebSocketChannel(
    ws: WebSocket,
    publish: LocalFunctionDefinition[]
): Promise<Channel> {
    if (ws.readyState !== 1) {
        if (ws.readyState !== 0) {
            throw new Error('web socket already closed');
        } else {
            await new Promise((r, f) => {
                ws.addEventListener('open', r);
                ws.addEventListener('error', f);
            });
        }
    }

    return createChannel({
        send: (o: any) => ws.send(JSON.stringify(o)),
        registerReceive(receive) {
            ws.addEventListener('message', (o: any) => receive(JSON.parse(o)));
        },
        registerClose(close) {
            ws.addEventListener('close', close);
        },
        publish,
    });
}

function validate(value: any, type: Sendable): boolean {
    if (isNumber(type)) {
        // basic type
        switch (type) {
            case 0:
                return value === null;
            case 1:
                return isString(value);
            case 2:
                return isNumber(value);
            case 3:
                return isBool(value);
            default:
                return false;
        }
    } else if (isArray(type)) {
        // fixed structure array
        if (isArray(value)) {
            return (
                type.length === value.length &&
                value
                    .map((v, i) => [v, type[i]])
                    .every(([v, t]) => validate(v, t))
            );
        } else {
            return false;
        }
    } else if (isObject(type)) {
        if (type.hasOwnProperty('$c')) {
            if (isArray(value) && type.$c === 4) {
                // variable structure array
                return value.every((v) => validate(v, type.$v));
            } else if (type.$c === 5 && isObject(value)) {
                // variable structure object
                return (
                    Object.keys(value).every((k) => validate(k, type.$k)) &&
                    Object.values(value).every((v) => validate(v, type.$v))
                );
            } else if (type.$c === 6) {
                // typed union
                return Object.values(type.$t).some((t) => validate(value, t));
            } else {
                return false;
            }
        } else {
            // fixed structure object
            const vres = value as {[key: string]: any};
            const tres = type as {[key: string]: Sendable};
            // must have same keys
            // keys must have the right types
            return (
                Object.keys(type).every((k) => value.hasOwnProperty(k)) &&
                Object.keys(value).every((k) => type.hasOwnProperty(k)) &&
                Object.keys(value).every((k) => validate(vres[k], tres[k]))
            );
        }
    } else {
        // log('could not resolve type', type, value);
        return false;
    }
}

const isArray = Array.isArray;
const isString = (x: any): x is string => typeof x === 'string';
const isNumber = (x: any): x is number => typeof x === 'number';
const isBool = (x: any): x is boolean => typeof x === 'boolean';
const isObject = (x: any): x is object => typeof x === 'object' && !isArray(x);
