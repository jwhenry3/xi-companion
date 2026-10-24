// Electron shell for the XI Companion overlay.
//
// A borderless, always-on-top window that loads the addon's HTTP server
// (localhost:<port>). Clicks on the window belong to the UI; clicks outside
// go to the game — no click-through logic, no input hooks.
//
//   npm run overlay            # default port 17890
//   GSUI_PORT=1234 npm run overlay

const { app, BrowserWindow } = require('electron');

// own userData dir — the default 'Electron' profile can be left locked by
// stray electron.exe processes, which shows up as cache_util 'Access denied'
// and can pin the window to a stale disk cache
app.setName('xicompanion-overlay');

// borderless always-on-top windows resize-crash some GPU driver stacks;
// the overlay doesn't need GPU compositing anyway
app.disableHardwareAcceleration();

// process-gone events land in overlay.log (launcher pipes stdio there)
app.on('render-process-gone', (_e, _wc, details) => {
    console.error('[overlay] renderer gone:', details.reason);
});
app.on('child-process-gone', (_e, details) => {
    console.error('[overlay] child gone:', details.type, details.reason);
});

const PORT = process.env.GSUI_PORT || 17890;
const URL_ = `http://127.0.0.1:${PORT}/`;

function create() {
    const win = new BrowserWindow({
        width: 1100,
        height: 760,
        // the layout is viewport-fitting — inner panes scroll, the page
        // never does — so this floor is about usability, not content size
        useContentSize: true,
        minWidth: 860,
        minHeight: 520,
        alwaysOnTop: true,
        skipTaskbar: true,
        frame: false,
        resizable: true,
        autoHideMenuBar: true,
        backgroundColor: '#020617',
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    // 'screen-saver' is the strongest level — 'floating' gets covered when a
    // borderless game asserts topmost on focus (looks like the window closed)
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setMenuBarVisibility(false);

    // the launcher spawns us with windowsHide (SW_HIDE in STARTUPINFO) to
    // suppress a console flash — Chromium honors that flag for the first
    // window, so show() explicitly or the window stays hidden until a
    // second-instance call unhides it
    win.show();
    win.focus();

    // frameless+skipTaskbar windows auto-minimize on Windows when another
    // window takes focus — cancel it
    win.on('minimize', () => win.restore());

    // a borderless always-on-top window has no taskbar entry or chrome, so
    // re-assert z-order periodically in case the game pushes past it, and
    // give the user a hide key since there's nothing else to close it with
    // (//xic overlay / FAB re-shows it via the second-instance handler)
    const keepTop = setInterval(() => {
        if (win.isDestroyed()) {
            clearInterval(keepTop);
            return;
        }
        // z-order churn while the window is focused (i.e. the user is
        // interacting with it) dismisses native <select> popups — only
        // re-pin when the game has focus, which is when it can cover us
        if (win.isFocused()) return;
        win.setAlwaysOnTop(true, 'screen-saver');
        if (win.isVisible() && !win.isMinimized()) win.moveTop();
    }, 2000);
    win.webContents.on('before-input-event', (_e, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape') win.hide();
    });

    win.loadURL(URL_);

    win.webContents.on('did-finish-load', () => {
        // frameless window: make the app header the drag handle
        win.webContents.insertCSS(`
            header { -webkit-app-region: drag; }
            header a, header button, header input, header select,
            header .nav-link { -webkit-app-region: no-drag; }
        `);
    });

    // if the addon server isn't up yet, retry on load failure
    win.webContents.on('did-fail-load', () => {
        setTimeout(() => win.loadURL(URL_), 2000);
    });
}

// FAB clicks and //xic overlay can fire repeatedly — focus the existing
// window instead of stacking instances.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
            // re-invocation doubles as a refresh so rebuilds surface without
            // hunting for the window — bypass the cache or stale bundles stick
            win.webContents.reloadIgnoringCache();
        }
    });
    app.whenReady().then(create);
}
app.on('window-all-closed', () => app.quit());
