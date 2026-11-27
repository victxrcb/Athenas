/** Turns notifications on and off for this browser. */
import { api } from './api';

export const supported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window;

export function registerWorker() {
  if (supported()) void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

function bytes(base64url: string): Uint8Array<ArrayBuffer> {
  const text = atob(base64url.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

const sameKey = (current: ArrayBuffer | null | undefined, wanted: Uint8Array) => {
  if (!current) return false;
  const value = new Uint8Array(current);
  return value.length === wanted.length && value.every((byte, index) => byte === wanted[index]);
};

/** Whether this browser still holds a subscription; the computer may remember one the browser dropped. */
export async function subscribed(): Promise<boolean> {
  if (!supported() || Notification.permission !== 'granted') return false;
  const registration = await navigator.serviceWorker.getRegistration();
  return Boolean(await registration?.pushManager.getSubscription());
}

/** Must start from a tap: the browser only asks for permission then. */
export async function enable(): Promise<void> {
  if (await Notification.requestPermission() !== 'granted') throw new Error('As notificações estão bloqueadas. Libere-as nas configurações do Chrome para este site.');
  await navigator.serviceWorker.register('/sw.js');
  const registration = await navigator.serviceWorker.ready;
  const key = bytes((await api.pushKey()).publicKey);
  let subscription = await registration.pushManager.getSubscription();
  // A subscription made for another computer key can never receive from this one.
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const { endpoint, keys } = subscription.toJSON();
  if (!endpoint || !keys?.p256dh || !keys.auth) throw new Error('O navegador não criou a inscrição de notificações.');
  await api.pushSubscribe({ endpoint, p256dh: keys.p256dh, auth: keys.auth });
}

export async function dropLocal(): Promise<void> {
  if (!supported()) return;
  const registration = await navigator.serviceWorker.getRegistration();
  await (await registration?.pushManager.getSubscription())?.unsubscribe();
}

export async function disable(): Promise<void> {
  await api.pushUnsubscribe();
  await dropLocal();
}
