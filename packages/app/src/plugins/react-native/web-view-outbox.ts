export interface WebViewOutbox {
  post(data: string): void;
  loaded(): void;
  reset(): void;
}

// A message sent before the document has loaded has no listener yet, so hold it until it does.
export function createWebViewOutbox(deliver: (data: string) => void): WebViewOutbox {
  let loaded = false;
  const pending: string[] = [];
  return {
    post(data) {
      if (loaded) deliver(data);
      else pending.push(data);
    },
    loaded() {
      loaded = true;
      for (const data of pending.splice(0)) deliver(data);
    },
    reset() {
      loaded = false;
    },
  };
}
