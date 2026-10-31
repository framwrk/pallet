import { AppChannels, SettingsChannels, WindowChannels } from "@shared/ipc/ipc.constants";
import { BrowserWindow, Menu, app, ipcMain, session, shell } from "electron";
import { editSessions, sessionManager } from "./ipc/sftp";
import { installCrashHandlers, log, logFilePath } from "./services/logger";
import { is, optimizer } from "@electron-toolkit/utils";
import { isAllowedExternalUrl, isAllowedNavigation } from "./utils/navigation-policy";
import { quitAfterTransfers, setQuitCleanup } from "./services/quit";
import type { IpcResult } from "@shared/ipc/ipc.types";
import { join } from "path";
import { pathToFileURL } from "url";
import { registerIpcHandlers } from "./ipc/register";
import { startUpdateChecks } from "./services/update-checker";
import { transferQueue } from "./ipc/transfer";

/** Lock a window to its own document and keep external links to http(s). */
function guardWindowNavigation(win: BrowserWindow, entryFile: string): void {
  const devOrigin = is.dev ? process.env["ELECTRON_RENDERER_URL"] : undefined;
  const policy = { devOrigin, entryFileUrl: pathToFileURL(entryFile).href };

  win.webContents.on("will-navigate", (event) => {
    if (!isAllowedNavigation(event.url, policy)) event.preventDefault();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
}

/** The file-manager window; the Close accelerator asks its renderer first. */
let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const entryFile = join(__dirname, "../renderer/index.html");
  const win = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 820,
    minHeight: 480,
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  mainWindow = win;

  win.on("ready-to-show", () => {
    win.show();
  });

  win.on("closed", () => {
    mainWindow = null;
  });

  guardWindowNavigation(win, entryFile);

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    win.loadFile(entryFile);
  }
}

/** Single settings window; a second request focuses the existing one. */
let settingsWindow: BrowserWindow | null = null;

function openSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  const entryFile = join(__dirname, "../renderer/settings.html");
  const win = new BrowserWindow({
    width: 520,
    // The General tab's natural height, so the window opens at its final size;
    // the renderer reports the exact figure for each tab as you switch.
    height: 165,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: "Settings",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  settingsWindow = win;

  win.on("ready-to-show", () => win.show());
  win.on("closed", () => {
    settingsWindow = null;
  });

  guardWindowNavigation(win, entryFile);

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(new URL("settings.html", process.env["ELECTRON_RENDERER_URL"]).toString());
  } else {
    win.loadFile(entryFile);
  }
}

/**
 * Settings tabs hold different amounts of content, and a macOS settings window
 * is expected to grow or shrink to fit rather than leave dead space. The
 * renderer measures its own content and reports it here.
 */
function registerSettingsWindowHandlers(): void {
  ipcMain.handle(SettingsChannels.resize, (event, contentHeight: number, title: string): IpcResult<void> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && win === settingsWindow && !win.isDestroyed()) {
      win.setTitle(title);
      const [width, height] = win.getContentSize();
      const next = Math.round(contentHeight);
      if (next > 0 && Math.abs(height - next) > 1) win.setContentSize(width, next, true);
    }
    return { ok: true, value: undefined };
  });
}

function buildMenu(): void {
  // ⌘, lives on a menu item rather than a renderer key handler: menu
  // accelerators fire from any window, and even while a text field has focus.
  const settingsItem: Electron.MenuItemConstructorOptions = {
    label: "Settings…",
    accelerator: "Cmd+,",
    click: () => openSettingsWindow(),
  };

  // ⌘W must not close the window outright while the remote pane is selected:
  // the Close accelerator asks the main window's renderer, which disconnects
  // the remote pane if it is active and closes the window otherwise. The
  // stock fileMenu/windowMenu roles bake in a plain close, so they are
  // spelled out here.
  const closeItem: Electron.MenuItemConstructorOptions = {
    label: "Close",
    accelerator: "Cmd+W",
    click: () => {
      const focused = BrowserWindow.getFocusedWindow();
      if (!focused) return;
      if (focused === mainWindow) focused.webContents.send(WindowChannels.closeRequest);
      else focused.close();
    },
  };

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        settingsItem,
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [closeItem],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    {
      label: "Window",
      submenu: [{ role: "minimize" }, { role: "zoom" }],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Reveal Log in Finder",
          click: () => shell.showItemInFolder(logFilePath()),
        },
        {
          label: "Report an Issue…",
          click: () => void shell.openExternal("https://github.com/framwrk/pallet/issues"),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  installCrashHandlers();
  log("app start", app.getVersion());

  // The renderer only writes text to the clipboard (copy database path).
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "clipboard-sanitized-write");
  });

  app.on("browser-window-created", (_, window) => {
    optimizer.watchWindowShortcuts(window);
  });

  registerIpcHandlers();
  registerSettingsWindowHandlers();
  buildMenu();
  createWindow();

  startUpdateChecks((info) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(AppChannels.updateAvailable, info);
    }
  });

  app.on("activate", function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Pallet stays in the dock after its last window closes, and `activate` reopens
// one. Subscribing at all is what makes that happen: with no listener, Electron
// quits the app by default.
app.on("window-all-closed", () => {});

/** Held so the quit we start after cleanup is not intercepted again. */
let cleaningUp = false;

app.on("before-quit", (event) => {
  if (cleaningUp) return;
  if (!transferQueue.hasActiveTransfers()) {
    // Close SSH sessions cleanly; avoids half-open channels server-side.
    sessionManager.disconnectAll();
    // Remove edit temp copies and stop pending re-uploads.
    void editSessions.closeAll();
    return;
  }
  // Streams die with the process, leaving `.pallet-part` files behind. Hold
  // the quit until the queue cancels them and its staging cleanup finishes.
  event.preventDefault();
  cleaningUp = true;
  void quitAfterTransfers();
});

setQuitCleanup(async () => {
  const result = await transferQueue.shutdown();
  sessionManager.disconnectAll();
  // Remove edit temp copies and stop pending re-uploads.
  await editSessions.closeAll();
  return result;
});
