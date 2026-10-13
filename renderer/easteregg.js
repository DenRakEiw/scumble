// @ts-check
/**
 * A tiny Brainfuck interpreter for in-app easter eggs and greetings.
 * Pure ASCII, 0 external dependencies.
 */

/**
 * Execute a Brainfuck program and return its output as a string.
 * @param {string} code
 * @param {string} [input=""]
 * @returns {string}
 */
export function runBrainfuck(code, input = "") {
    const mem = new Uint8Array(30000);
    let ptr = 0, pc = 0, inPtr = 0, out = "";
    /** @type {Record<number, number>} */
    const jumps = {};
    /** @type {number[]} */
    const stack = [];
    for (let i = 0; i < code.length; i++) {
        if (code[i] === "[") {
            stack.push(i);
        } else if (code[i] === "]") {
            if (stack.length === 0) throw new Error("Brainfuck syntax error: unmatched ']' at " + i);
            const start = stack.pop();
            if (start !== undefined) {
                jumps[start] = i;
                jumps[i] = start;
            }
        }
    }
    if (stack.length > 0) throw new Error("Brainfuck syntax error: unmatched '[' at " + stack[stack.length - 1]);

    const maxOps = 1000000;
    let ops = 0;
    while (pc < code.length) {
        if (++ops > maxOps) throw new Error("Brainfuck execution limit exceeded");
        const cmd = code[pc];
        if (cmd === ">") ptr = (ptr + 1) % 30000;
        else if (cmd === "<") ptr = (ptr + 29999) % 30000;
        else if (cmd === "+") mem[ptr] = (mem[ptr] + 1) & 255;
        else if (cmd === "-") mem[ptr] = (mem[ptr] - 1) & 255;
        else if (cmd === ".") out += String.fromCharCode(mem[ptr]);
        else if (cmd === ",") mem[ptr] = inPtr < input.length ? input.charCodeAt(inPtr++) & 255 : 0;
        else if (cmd === "[" && mem[ptr] === 0) pc = jumps[pc];
        else if (cmd === "]" && mem[ptr] !== 0) pc = jumps[pc];
        pc++;
    }
    return out;
}

/**
 * Secret Brainfuck greeting: "Welcome to Scumble!"
 */
export const BF_GREETING =
    "++++++++++[>+++>+++++++>++++++++++>++++++++++++<<<<-]>>>-------------.++++++++++++++.+++++++.---------.>---------.--.<++.<<++.>>>+++++++.-----.<<<.>+++++++++++++.>--.>++++++.--------.<-.>-.<+++.<<+.";

/**
 * Secret Brainfuck word: "Scumble"
 */
export const BF_SCUMBLE =
    "++++++++++[>++++++++>++++++++++>+++++++++++>++++++++++++<<<<-]>+++.>-.>>---.<-.<-.>-.<+++.";

/**
 * Returns the decoded secret welcome message.
 * @returns {string}
 */
export function getSecretGreeting() {
    return runBrainfuck(BF_GREETING);
}

/**
 * Returns the decoded word "Scumble".
 * @returns {string}
 */
export function getScumbleWord() {
    return runBrainfuck(BF_SCUMBLE);
}

/** The mascot and wordmark as a Brainfuck program (built by tools/bf_logo.py). */
export const LOGO_URL = new URL("./easteregg/logo.bf", import.meta.url);

/** @type {Promise<string> | null} */
let logo = null;

/**
 * Fetches logo.bf and returns what it prints: the Scumble mascot and wordmark in ASCII.
 * @returns {Promise<string>}
 */
export function getScumbleLogo() {
    if (!logo) {
        logo = fetch(LOGO_URL)
            .then((r) => { if (!r.ok) throw new Error("logo.bf: " + r.status); return r.text(); })
            .then((code) => runBrainfuck(code));
        logo.catch(() => { logo = null; });
    }
    return logo;
}
