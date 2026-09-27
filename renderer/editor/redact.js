// @ts-check
// What an exported PNG must not carry (the user, 2026-09-27: "ja, weglassen"). The PNG export embeds the selected
// recipe (host.workflowInfo, on by default since 0.1.32), and a recipe imported from a ComfyUI workflow holds every
// widget value of that workflow as it was saved: a third-party API node's key widget included. Anyone the picture
// reaches could read the key out of its tEXt chunk. So the inputs whose *name* says they hold a secret are left out of
// what is embedded; the recipe on disk and the prompt that is queued keep them, since the run needs them.
//
// App-only: host.js is the one importer, and the ComfyUI node embeds its own graph (tools/build_node.py FILES leaves
// this file out, as it leaves out stitch.js). Pure, so tools/secret_names_test.js runs it in plain Node.

// A name is taken apart into its words: camelCase and acronyms split ("myAPIKey" -> my, api, key), separators and digits
// dropped ("api_key_2", "X-Auth-Token"), lower case.
function nameWords(name) {
    return String(name)
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .split(/[^A-Za-z]+/)
        .filter(Boolean)
        .map((w) => w.toLowerCase());
}

// Anywhere in the name, the words run together ("openai_api_key" -> "openaiapikey", "clientSecret" -> "clientsecret"):
// words no ordinary widget is named with. `api_key` and `apikey` are one spelling once the separators are gone.
const ANYWHERE = /apikey|apitoken|secret|password|passwd|passphrase|bearer|credential/;

// `auth` as a word of its own or the start of one that means authentication ("auth_header", "oauth", "Authorization"),
// never `author`, `authors` or `authority`, which metadata nodes do have.
const AUTH_WORD = /^o?auth(?:entication|enticate|ori[sz]ation|header|token|key|code)?s?$/;

// `key` and `token` only as the name's last word, its head noun ("api_key", "fal_key", "apiKey", "hf_token",
// "accessToken"): widgets that are not secrets have them in front ("keyframe", "key_color", "keyFrame",
// "token_normalization", Advanced CLIP Text Encode's) or in another word ("monkey", "hotkey", "max_tokens",
// "tokenizer"). A few runs-together spellings of a key count too ("accesskey", "privatekey", "passkey").
const LAST_WORD = /^(?:api|access|private|secret|auth|pass|licen[cs]e)?keys?$|token$/;

/**
 * Does an input or widget named `name` hold a secret: an API key, a token, a password, credentials? By its name alone,
 * case-insensitive; the value is never looked at. Paths are not secrets here (the user asked about keys only).
 * @param {unknown} name
 * @returns {boolean}
 */
export function isSecretName(name) {
    if (typeof name !== "string" || !name) return false;
    const words = nameWords(name);
    if (!words.length) return false;
    if (ANYWHERE.test(words.join(""))) return true;
    if (words.some((w) => AUTH_WORD.test(w))) return true;
    return LAST_WORD.test(words[words.length - 1]);
}

/**
 * A copy of an API-format prompt (`{ "<id>": { class_type, inputs, _meta } }`, docs/RECIPES.md) without its secrets:
 * every input `isSecretName` flags is left out, at any depth of an input's value (an object widget, a list of them).
 * A flagged input that is wired (`["<id>", slot]`) takes the literal inputs of the nodes that feed it along, upstream as
 * far as the wires go: a key typed into a PrimitiveString node, or two strings concatenated into one, sits in an input
 * called `value` or `string_a`, which no name gives away. Their wires stay, so the graph still reads. Node ids, class
 * types and `_meta` are the format's own and are kept. Anything that is not a prompt object comes back as it is.
 * @template T
 * @param {T} prompt
 * @returns {T}
 */
export function withoutSecrets(prompt) {
    if (!prompt || typeof prompt !== "object" || Array.isArray(prompt)) return prompt;
    const nodes = /** @type {Record<string, any>} */ (prompt);
    const own = (id) => Object.prototype.hasOwnProperty.call(nodes, id);
    const wire = (v) => Array.isArray(v) && v.length === 2 && Number.isInteger(v[1]) && (typeof v[0] === "string" || typeof v[0] === "number") && own(String(v[0]));
    // the nodes that feed a secret input, and theirs in turn
    const feeders = new Set();
    const todo = [];
    for (const node of Object.values(nodes)) {
        const inputs = node && node.inputs;
        if (!inputs || typeof inputs !== "object") continue;
        for (const [k, v] of Object.entries(inputs)) if (isSecretName(k) && wire(v)) todo.push(String(v[0]));
    }
    while (todo.length) {
        const id = todo.pop();
        if (feeders.has(id)) continue;
        feeders.add(id);
        const inputs = nodes[id] && nodes[id].inputs;
        if (inputs && typeof inputs === "object") for (const v of Object.values(inputs)) if (wire(v)) todo.push(String(v[0]));
    }
    const scrub = (v) => {
        if (Array.isArray(v)) return v.map(scrub);
        if (v && typeof v === "object") {
            const out = {};
            for (const [k, x] of Object.entries(v)) if (!isSecretName(k)) out[k] = scrub(x);
            return out;
        }
        return v;
    };
    const out = {};
    for (const [id, node] of Object.entries(nodes)) {
        if (!node || typeof node !== "object" || !node.inputs || typeof node.inputs !== "object") { out[id] = node; continue; }
        let inputs = scrub(node.inputs);
        if (feeders.has(id)) inputs = Object.fromEntries(Object.entries(inputs).filter(([, v]) => wire(v)));
        out[id] = { ...node, inputs };
    }
    return /** @type {T} */ (/** @type {unknown} */ (out));
}
