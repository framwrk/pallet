import { AppChannels, SettingsChannels, TerminalChannels, WindowChannels } from "@shared/ipc/ipc.constants";
import { BrowserWindow, Menu, app, session, shell } from "electron";
import { editSessions, sessionManager } from "./ipc/sftp";
import {
  getKeybindingsState,
  isKeybindingRecording,
  loadKeybindings,
  onKeybindingRecordingChange,
  onKeybindingsChange,
  setKeybindingRecording,
  stopWatchingKeybindings,
  watchKeybindings,
} from "./services/keybindings-store";
import { installCrashHandlers, log, logFilePath } from "./services/logger";
import { isAllowedExternalUrl, isAllowedNavigation } from "./utils/navigation-policy";
import { quitAfterTransfers, setQuitCleanup } from "./services/quit";
import { restoreWindowState, trackWindowState } from "./services/window-state";
import type { CommandId } from "@shared/keybindings/keybinding.types";
import { is } from "@electron-toolkit/utils";
import { join } from "path";
import { pathToFileURL } from "url";
import { registerIpcHandlers } from "./ipc/register";
import { startUpdateChecks } from "./services/update-checker";
import { terminalSessions } from "./ipc/terminal";
import { toAccelerator } from "@shared/keybindings/keybinding.utils";
import { transferQueue } from "./ipc/transfer";
import { watchDevShortcuts } from "./services/dev-shortcuts";

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

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const entryFile = join(__dirname, "../renderer/index.html");
  const restored = restoreWindowState();
  const win = new BrowserWindow({
    ...restored.bounds,
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

  trackWindowState(win);

  win.on("blur", () => setKeybindingRecording(false));
  win.webContents.on("did-start-loading", () => setKeybindingRecording(false));

  win.on("ready-to-show", () => {
    if (restored.maximized) win.maximize();
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

function menuAccelerator(id: CommandId): string | undefined {
  if (isKeybindingRecording()) return undefined;
  const key = getKeybindingsState().effective[id];
  return key ? toAccelerator(key) : undefined;
}

function buildMenu(): void {
  // ⌘, lives on a menu item rather than a renderer key handler: menu
  // accelerators fire from any window and any focus, and it now opens the
  // in-app Settings modal over the main window.
  const settingsItem: Electron.MenuItemConstructorOptions = {
    label: "Settings…",
    accelerator: menuAccelerator("panels.settings"),
    click: () => {
      mainWindow?.webContents.send(SettingsChannels.openRequest);
    },
  };

  const toggleTerminalItem: Electron.MenuItemConstructorOptions = {
    label: "Toggle Terminal",
    accelerator: menuAccelerator("panels.toggleTerminal"),
    click: () => {
      const focused = BrowserWindow.getFocusedWindow();
      if (!focused || focused !== mainWindow) return;
      focused.webContents.send(TerminalChannels.toggleRequest);
    },
  };

  const closeItem: Electron.MenuItemConstructorOptions = {
    label: "Close Remote Pane",
    accelerator: menuAccelerator("panels.closeRemotePane"),
    click: () => {
      const focused = BrowserWindow.getFocusedWindow();
      if (!focused || focused !== mainWindow) return;
      focused.webContents.send(WindowChannels.closeRequest);
    },
  };

  const devViewItems: Electron.MenuItemConstructorOptions[] = is.dev
    ? [{ role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" }]
    : [];

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
      submenu: [toggleTerminalItem, closeItem],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [...devViewItems, { role: "togglefullscreen" }],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        {
          label: "Close Window",
          click: () => {
            BrowserWindow.getFocusedWindow()?.close();
          },
        },
      ],
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

  app.setAboutPanelOptions({
    applicationName: "Pallet",
    applicationVersion: app.getVersion(),
    copyright: "Copyright © 2026 Framwrk",
  });

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === "clipboard-sanitized-write");
  });

  app.on("browser-window-created", (_, window) => {
    watchDevShortcuts(window);
  });

  loadKeybindings();
  registerIpcHandlers();
  onKeybindingsChange(() => buildMenu());
  onKeybindingRecordingChange(() => buildMenu());
  buildMenu();
  watchKeybindings();
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

let cleaningUp = false;

app.on("before-quit", (event) => {
  stopWatchingKeybindings();
  if (cleaningUp) return;
  if (!transferQueue.hasActiveTransfers()) {
    terminalSessions.closeAll();
    sessionManager.disconnectAll();
    void editSessions.closeAll();
    return;
  }
  event.preventDefault();
  cleaningUp = true;
  void quitAfterTransfers();
});

setQuitCleanup(async () => {
  const result = await transferQueue.shutdown();
  terminalSessions.closeAll();
  sessionManager.disconnectAll();
  await editSessions.closeAll();
  return result;
});
