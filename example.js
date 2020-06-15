const lwrpc = require('lwrpc');
const {H} = lwrpc;

let r = () => {};
let c = () => {};

const channel = lwrpc.createChannel({
    send(x) {r(x);},
    registerReceive(receive){r = receive;},
    registerClose(close){c = close;},
    logging: console.debug,
});

async function demo() {
    channel.publish({
        name: 'add',
        args: [H.number, H.number],
        returns: H.number,
        fn: (a,b) => a+b,
    });

    console.log(await channel.add(3,5));
}

demo();
