import { BrowserWindow, Menu, app, ipcMain, shell } from "electron";
import { join } from "path";
import { electronApp, is, optimizer } from "@electron-toolkit/utils";
import icon from "../../resources/icon.png?asset";
import { registerIpcHandlers } from "./ipc";
import { sessionManager } from "./ipc/sftp";
import { AppChannels, SettingsChannels } from "../shared/ipc";
import type { IpcResult } from "../shared/types";
import { startUpdateChecks } from "./services/update-checker";
import { installCrashHandlers, log, logFilePath } from "./services/logger";

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 820,
    minHeight: 480,
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 14, y: 14 },
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: "deny" };
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    mainWindow.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
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
    ...(process.platform === "linux" ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
    },
  });
  settingsWindow = win;

  win.on("ready-to-show", () => win.show());
  win.on("closed", () => {
    settingsWindow = null;
  });

  if (is.dev && process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(new URL("settings.html", process.env["ELECTRON_RENDERER_URL"]).toString());
  } else {
    win.loadFile(join(__dirname, "../renderer/settings.html"));
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
    accelerator: "CmdOrCtrl+,",
    click: () => openSettingsWindow(),
  };
  const isMac = process.platform === "darwin";

  const template: Electron.MenuItemConstructorOptions[] = [
    isMac
      ? {
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
        }
      : { label: "File", submenu: [settingsItem, { type: "separator" }, { role: "quit" }] },
    ...(isMac ? [{ role: "fileMenu" } as Electron.MenuItemConstructorOptions] : []),
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
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
  electronApp.setAppUserModelId("com.framwrk.pallet");
  installCrashHandlers();
  log("app start", app.getVersion());

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

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  // Close SSH sessions cleanly; avoids half-open channels server-side.
  sessionManager.disconnectAll();
});
