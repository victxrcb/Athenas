type Request = { message: string; resolve: (ok: boolean) => void };
type Listener = (request: Request | null) => void;

let listener: Listener | null = null;

export function subscribeConfirm(next: Listener): () => void {
  listener = next;
  return () => { if (listener === next) listener = null; };
}

// window.confirm is unreliable inside the Tauri webview and cannot be themed, so the app renders its own dialog.
export function confirmAction(message: string): Promise<boolean> {
  if (!listener) return Promise.resolve(window.confirm(message));
  const show = listener;
  return new Promise((resolve) => show({ message, resolve }));
}
