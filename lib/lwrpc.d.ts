declare type subtype<parent, label> = parent & {
    _: label;
};
declare type RemoteFunctionName = subtype<string, 'remote_function_name'>;
export declare type LocalFunctionName = subtype<string, 'published_function_name'>;
export declare type Sendable = 0 | 1 | 2 | 3 | VariableStructureArraySendable | VariableStructureObjectSendable | UnionSendable | Sendable[] | {
    [key: string]: Sendable;
};
declare type VariableStructureArraySendable = {
    $c: 4;
    $v: Sendable;
};
declare type VariableStructureObjectSendable = {
    $c: 5;
    $k: 1 | 2;
    $v: Sendable;
};
declare type UnionSendable = {
    $c: 6;
    $t: Sendable[];
};
declare type SendableHelper = {
    none: 0;
    string: 1;
    number: 2;
    boolean: 3;
    array: (v: Sendable) => VariableStructureArraySendable;
    object: (k: 1 | 2, v: Sendable) => VariableStructureObjectSendable;
    union: (...u: Sendable[]) => UnionSendable;
};
export declare const H: SendableHelper;
export declare type LocalFunction = (...args: any[]) => Promise<any>;
export declare type LocalFunctionDefinition = {
    name: LocalFunctionName;
    args: Sendable[];
    returns: Sendable;
    fn: LocalFunction;
};
export declare type RemoteFunctionDefinition = {
    name: RemoteFunctionName;
    args: Sendable[];
    returns: Sendable;
};
export declare type ChannelParams = {
    send: (o: any) => void;
    registerReceive: (receive: (o: any) => Promise<void>) => void;
    registerClose: (close: () => void) => void;
    publish?: LocalFunctionDefinition[];
    logging?: boolean | ((...args: any[]) => void);
};
declare type Channel = {
    publish: (rfd: LocalFunctionDefinition) => void;
} & {
    [key: string]: (...args: any) => Promise<any>;
};
export declare function createChannel(params: ChannelParams): Channel;
export declare function createWebSocketChannel(ws: WebSocket, publish: LocalFunctionDefinition[]): Promise<Channel>;
export {};
