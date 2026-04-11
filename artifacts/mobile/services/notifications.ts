export async function registerForPushTokenAsync(): Promise<null> {
  return null;
}

export async function getStoredPushToken(): Promise<null> {
  return null;
}

export async function requestNotificationPermissions(): Promise<boolean> {
  return false;
}

export async function getNotificationPermissionStatus(): Promise<null> {
  return null;
}

export async function sendLiveServiceNotification(_title: string): Promise<void> {
  // Not supported on web
}

export async function sendNewSermonNotification(_sermonTitle: string): Promise<void> {
  // Not supported on web
}

export async function cancelAllNotifications(): Promise<void> {
  // Not supported on web
}

export async function setupAndroidNotificationChannel(): Promise<void> {
  // Not supported on web
}
