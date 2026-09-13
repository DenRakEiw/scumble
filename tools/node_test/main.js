// Electron main for tools/node_test.py: load the stub page, wait for its result, print it.
const { app, BrowserWindow } = require("electron");
const url = process.argv[process.argv.length - 1];
app.whenReady().then(async () => {
    const w = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { backgroundThrottling: false } });
    await w.loadURL(url);
    const t0 = Date.now();
    let result = null;
    while (Date.now() - t0 < 120000) {
        result = await w.webContents.executeJavaScript("window.__result && window.__result.done ? window.__result : null");
        if (result) break;
        await new Promise((r) => setTimeout(r, 250));
    }
    process.stdout.write("NODE_TEST_RESULT " + JSON.stringify(result) + "\n");
    app.exit(0);
});
