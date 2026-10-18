// Preload for the plain-Node provider tests (`node -r ./tools/nonet.js tools/<x>_test.js`): the real global fetch
// refuses every request and says so on stderr (NONET-FIRED), as does a socket to anything but loopback. A test that
// passes under it made no connection outside this machine.
"use strict";
const NONET = async (url) => {
    process.stderr.write("NONET-FIRED " + String(url && url.url || url) + String.fromCharCode(10));
    throw new TypeError("nonet: refused a real fetch to " + String(url && url.url || url));
};
globalThis.fetch = NONET;
const net = require("node:net");
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
    const o = args[0] && typeof args[0] === "object" ? args[0] : { port: args[0], host: args[1] };
    const host = String(o.host || o.path || "");
    if (o.path || host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "") {
        if (!o.path) process.stderr.write("NONET-LOOPBACK " + host + ":" + o.port + String.fromCharCode(10));
        return origConnect.apply(this, args);
    }
    process.stderr.write("NONET-SOCKET " + host + String.fromCharCode(10));
    throw new Error("nonet: refused a socket to " + host);
};
