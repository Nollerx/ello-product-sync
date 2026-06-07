import type * as React from "react";

declare module "*.css";

declare global {
  interface Window {
    elloHiddenProductIds?: Set<string>;
    elloHiddenTitles?: Set<string>;
    elloHiddenHandles?: Set<string>;
    ELLO_STORE_CONFIG?: Record<string, any>;
    ELLO_STORE_SLUG?: string;
    ELLO_STORE_ID?: string;
    ELLO_STORE_NAME?: string;
    ELLO_SESSION_ID?: string;
    ELLO_BOOTSTRAP_PROMISE?: Promise<any>;
    elloStoreConfig?: Record<string, any>;
    initializeWidget?: () => void;
    // Modern App Bridge global (injected by AppProvider in app.tsx). Minimal
    // surface — just the resource picker used by the Products page.
    shopify?: {
      resourcePicker: (options: {
        type: "product" | "collection" | "variant";
        multiple?: boolean;
        selectionIds?: Array<{ id: string }>;
        action?: "select" | "add";
      }) => Promise<Array<{ id: string; title?: string; handle?: string }> | undefined>;
    };
  }

  namespace JSX {
    interface IntrinsicElements {
      "s-app-nav": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      "s-link": React.DetailedHTMLProps<React.AnchorHTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

export {};
