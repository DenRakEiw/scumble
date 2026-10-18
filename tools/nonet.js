// Preload for the plain-Node provider tests (`node -r ./tools/nonet.js tools/<x>_test.js`): the real global fetch
// refuses every request off this machine and says so on stderr (NONET-FIRED), as does a socket to anything but
// loopback. A fetch to 127.0.0.1, localhost or ::1 (a test's own fake server) and a file:// read go through. A test
// that passes under it made no connection outside this machine.
"use strict";
const realFetch = globalThis.fetch;
const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const NONET = async (url, init) => {
    const href = String(url && url.url || url);
    let u = null;
    try { u = new URL(href); } catch (_) { /* not a URL: refused below */ }
    if (u && (u.protocol === "file:" || (/^https?:$/.test(u.protocol) && LOCAL.has(u.hostname)))) return realFetch(url, init);
    process.stderr.write("NONET-FIRED " + href + String.fromCharCode(10));
    throw new TypeError("nonet: refused a real fetch to " + href);
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
