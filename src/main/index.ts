import { app, shell, BrowserWindow, Menu } from "electron";
import { join } from "path";
import { electronApp, optimizer, is } from "@electron-toolkit/utils";
import icon from "../../resources/icon.png?asset";
import { registerIpcHandlers } from "./ipc";
import { sessionManager } from "./ipc/sftp";
import { AppChannels } from "../shared/ipc";
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

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: "appMenu" },
    { role: "fileMenu" },
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
