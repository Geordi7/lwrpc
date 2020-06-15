# lwrpc
## Lightweight Remote Procedure Call

lwrpc is a fairly simple library that fits over bidirectional object channels, such as for Web Workers, and -with some help- Web Sockets. It includes runtime type validation for all received data with support for most structures that can be expressed as JSON.

Usage follows roughly this pattern:
- define functions to expose on either side
- create function definition objects (used in argument and return value validation)
- create an object channel
- create the lwrpc Channel on top of it
- call functions on the other side with `await channel.functionName(...)`

---
## Detailed Instructions
### Define Functions

```typescript
function concat(s1: string, s2: string): string {
    return s1 + s2;
}
```

### Create Function Definition Objects
There is a special type helper called `H` which is used to create the type definitions.

```typescript
import {PublishedFunctionName, H} from 'lwrpc';

const fdo = {
    name: concat as PublishedFunctionName,
    args: [H.string, H.string],
    returns: H.string,
    fn: concat,
}
```

### Create an Object Channel
By default web-workers have an object channel which they share with the spawning context:

```javascript
const ww = new Worker('worker.js');
// send javascript objects to the worker
ww.postMessage({data: ['send', 'this']});
// set a function to receive javascript objects from the worker
ww.onmessage = console.log;
```

### Create the lwrpc Channel
To set up lwrpc with the worker do something like this:
```typescript
import {createChannel} from 'lwrpc';

const channel = createChannel({
    send: ww.postMessage,
    registerReceive: (receiveFunction) => {
        ww.onmessage = receiveFunction;
    },
    registerClose: () => {}, // web workers don't need to close
    publish: fdo, // pass in the function definitions from before
});
```

### Call the remote function
```typescript
// in worker.js
let message = await channel.concat('hello ', 'world');
```

---
## Websockets
lwrpc includes a tool to help set up a websocket based channel.

On the client side:
```typescript
import {createWebSocketChannel} from 'lwrpc';

const socket = new WebSocket('https://ws.mydomain.com');
const channel = await createWebSocketChannel(socket, fdo);
```

On the server side:
```typescript
import WebSocket from 'ws';
import {createWebSocketChannel} from 'lwrpc';

const wss = new WebSocket.Server({
    // ...
})

wss.on('connection', (ws, req) => {
    // check request authenticity

    ws.setMaxListeners(100);
    const channel = createWebSocketChannel(ws, fdo);

    // store the channel somewhere or start using it
    // ...
});
```

You must manually close the websocket to break the channel.

---
## Types Of Things

use the helper tool `H` to construct type definitions:

```javascript
// for basic types use the properties with the same names as the typescript types
H.string
H.number
H.boolean

// for fixed structure arrays or objects just create the structure
// remember that these only match identical size, property names, and value-types
[H.string, H.number]
{name: H.string, age: H.number}

// for variable structure arrays or objects use the helpers
H.array(H.string) // an array of strings
H.object(H.string, {name: H.string, age: H.number}) // object mapping strings to a fixed structure object
H.array([H.number, H.number, H.number]) // an array of 3 component vectors (as arrays)

// for union types, use the helper
H.union(H.boolean, H.array(H.number)) // either a boolean or an array of numbers
```

---
## Type Checking

In order for a function to be used it must have a detailed type specification, and it must always conform to it.

Arguments and Return Values are both validated by the recipient, here is the happy path:

```
A: send call request: fn(arg)
B: receive fn(arg)
B: check arg conforms to type definition of fn
B: call fn(arg) collect result
B: send result
A: receive result
A: check result conforms to type definition of fn
A: resolve promise with result
```

If the args do not conform, or the result does not conform, it will result in a promise rejection in `A`

---
## Closing the Channel

When it is constructed the channel registers its close function with the `registerClose` property of the parameters structure (if using `createChannel`).

If you call the close function, it will clean up all in-flight RPCs, and ignore any future results that are produced by RPCs that were requested by the other side.
