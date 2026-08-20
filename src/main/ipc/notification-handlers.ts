import { BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { NotificationManager } from '../notification/notification-manager';

export function registerNotificationHandlers(notificationManager?: NotificationManager): void {
  registerNotifyHandler(notificationManager);
  registerNotificationEnabledHandler(notificationManager);
}

function registerNotifyHandler(notificationManager?: NotificationManager): void {
  ipcMain.handle(IPC_CHANNELS.NOTIFY, (event, raw: unknown) =>
    handleNotify(notificationManager, event.sender, raw),
  );
}

function handleNotify(
  notificationManager: NotificationManager | undefined,
  sender: Electron.WebContents,
  raw: unknown,
): void {
  if (!notificationManager || !raw || typeof raw !== 'object') return;
  const request = raw as Record<string, unknown>;
  if (typeof request.title !== 'string' || typeof request.body !== 'string') return;
  notificationManager.show(
    {
      title: request.title,
      body: request.body,
      urgency: (request.urgency as 'low' | 'normal' | 'critical') ?? 'normal',
    },
    BrowserWindow.fromWebContents(sender),
  );
}

function registerNotificationEnabledHandler(notificationManager?: NotificationManager): void {
  ipcMain.handle(IPC_CHANNELS.NOTIFY_SET_ENABLED, (_event, raw: unknown) =>
    handleNotificationEnabled(notificationManager, raw),
  );
}

function handleNotificationEnabled(
  notificationManager: NotificationManager | undefined,
  raw: unknown,
): void {
  if (!notificationManager || typeof raw !== 'boolean') return;
  notificationManager.setEnabled(raw);
}
