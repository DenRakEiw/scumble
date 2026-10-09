# Scumble MCP extension

This bundle adds Scumble's MCP server to Claude Desktop (or any client that installs `.mcpb` bundles). It holds no
copy of Scumble: `server/index.js` finds the Scumble that is installed on this PC (the GitHub installer, the Microsoft
Store copy, or the portable copy named in the extension's settings) and starts its MCP launcher, the same thing
*Help › Copy MCP registration* in Scumble writes for a client by hand.

Install Scumble first: https://github.com/DenRakEiw/scumble (installer or portable zip) or the Microsoft Store
(https://apps.microsoft.com/detail/9NDBTNNMXF2R). Without it the extension offers one tool that says so.

`node server/index.js --where` prints what it found and the command it would run.

Documentation: https://github.com/DenRakEiw/scumble/blob/main/docs/MCP.md. GPL-3.0, like Scumble.
