const io = require(process.argv[2]);
const fs = require("fs");
const p = io.readPng(fs.readFileSync(process.argv[3]));
let s = 0; for (const v of p.data) s += v;
const P = io.prepare(p);
const sum = (a) => { let t = 0; for (const v of a) t += v; return t; };
console.log(JSON.stringify({ w: p.width, h: p.height, ch: p.channels, bytesum: s, first: Array.from(p.data.slice(0, 6)),
  cradio: sum(P.cradioIn), moge: sum(P.mogeIn), mogeHW: P.mogeHW, rvm: sum(P.rvmIn), code: sum(P.code), code0: P.code[0] }));
const h = io.hintHW(io.readPng(fs.readFileSync(process.argv[4]))); console.log("hint sum", sum(h));
