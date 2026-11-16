"use strict";
// Video files for the frame picker (CLAUDE.md item 68): File › Open on a video sends the window no bytes (a clip can
// be gigabytes, and one IPC message of about 512 MiB ends the renderer). Main grants the one path the user just chose
// a random token instead, and serves it at scumble://app/video/<token> with HTTP ranges, so the window's <video> reads
// only what it plays or seeks to. The token route itself is grantedfiles.js (File › Open's pictures use it too): no
// path in the URL, only a token main made for a file the open dialog returned, dropped again when the window closes
// its picker (release) or when more than MAX are held.

const { GrantedFiles, parseRange } = require("./grantedfiles");

/** The file names the picker takes (the open dialog's filter, the window's drop and the commands' refusal). */
const VIDEO_EXT = /\.(mp4|m4v|webm|mov)$/i;
// .mov goes as video/mp4: QuickTime and MP4 are the same box format, and Chromium's player opens an H.264 .mov under
// that type; what it cannot decode (ProRes, often HEVC) fails in the window, which refuses it in plain words
const TYPES = { ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/mp4", ".webm": "video/webm" };
const MAX = 8;

const isVideoPath = (file) => VIDEO_EXT.test(String(file || ""));

class VideoFiles extends GrantedFiles {
    constructor({ max = MAX } = {}) {
        super({ max, types: TYPES, words: { missing: "no such video", gone: "the video is gone" } });
    }
}

module.exports = { VideoFiles, VIDEO_EXT, isVideoPath, parseRange };
