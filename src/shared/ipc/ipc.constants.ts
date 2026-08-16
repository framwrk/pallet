/** Channel names for the window.pallet IPC surface. Single source of truth. */

export const FsChannels = {
  list: "fs:list",
  stat: "fs:stat",
  homeDir: "fs:homeDir",
  knownFolders: "fs:knownFolders",
  volumes: "fs:volumes",
  mkdir: "fs:mkdir",
  mkdirUnique: "fs:mkdirUnique",
  readPreview: "fs:readPreview",
  rename: "fs:rename",
  trash: "fs:trash",
  copy: "fs:copy",
  move: "fs:move",
  reveal: "fs:reveal",
  open: "fs:open",
} as const;

export const FolderSizeChannels = {
  get: "folderSize:get",
  cancel: "folderSize:cancel",
  invalidate: "folderSize:invalidate",
} as const;

export const UiChannels = {
  contextMenu: "ui:contextMenu",
  pickFile: "ui:pickFile",
} as const;

export const SftpChannels = {
  connect: "sftp:connect",
  disconnect: "sftp:disconnect",
  reconnect: "sftp:reconnect",
  list: "sftp:list",
  stat: "sftp:stat",
  realpath: "sftp:realpath",
  mkdir: "sftp:mkdir",
  mkdirUnique: "sftp:mkdirUnique",
  rename: "sftp:rename",
  remove: "sftp:remove",
  chmod: "sftp:chmod",
  readPreview: "sftp:readPreview",
  /** main → renderer session status events. */
  status: "sftp:status",
} as const;

export const AppChannels = {
  checkForUpdate: "app:checkForUpdate",
  openExternal: "app:openExternal",
  version: "app:version",
  revealLog: "app:revealLog",
  databasePath: "app:databasePath",
  /** main → renderer: a newer release exists. */
  updateAvailable: "app:updateAvailable",
} as const;

export const PrefChannels = {
  get: "prefs:get",
  set: "prefs:set",
  /** main → renderer: preferences changed, broadcast to every window. */
  changed: "prefs:changed",
} as const;

export const SettingsChannels = {
  /** Settings window only: size the window to the active tab's content. */
  resize: "settings:resize",
} as const;

export const EditChannels = {
  open: "edit:open",
  /** main → renderer re-upload notifications. */
  event: "edit:event",
} as const;

export const FavoriteChannels = {
  list: "favorites:list",
  save: "favorites:save",
  remove: "favorites:remove",
  reorder: "favorites:reorder",
  /** Connect using the stored secret; the secret never crosses to the renderer. */
  connect: "favorites:connect",
} as const;

export const TransferChannels = {
  enqueue: "transfer:enqueue",
  pause: "transfer:pause",
  resume: "transfer:resume",
  cancel: "transfer:cancel",
  retry: "transfer:retry",
  remove: "transfer:remove",
  resolveConflict: "transfer:resolveConflict",
  snapshots: "transfer:snapshots",
  /** main → renderer job snapshots. */
  update: "transfer:update",
  /** main → renderer conflict prompts. */
  conflict: "transfer:conflict",
} as const;

export const HostKeyChannels = {
  /** main → renderer verification prompts. */
  verify: "hostkeys:verify",
  respond: "hostkeys:respond",
} as const;
