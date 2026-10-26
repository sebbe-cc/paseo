// 0.13.0 port: upstream renamed file-pane/ to file-panels/.
import { htmlPreviewNavigationKind } from "@/file-panels/html-preview-navigation";

export interface WebViewNavigationRequest {
  url: string;
  // Android's synchronous decision path carries no frame information; absent means top frame.
  isTopFrame: boolean | undefined;
}

// The top frame may only load inert documents and fragments, so a page cannot replace itself with
// a remote one. Sub-frames belong to the page and answer to its own policy.
export function allowsWebViewNavigation(request: WebViewNavigationRequest): boolean {
  if (request.isTopFrame === false) return true;
  return htmlPreviewNavigationKind(request.url) !== "blocked";
}
