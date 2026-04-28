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
  }

  namespace JSX {
    interface IntrinsicElements {
      "s-app-nav": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      "s-link": React.DetailedHTMLProps<React.AnchorHTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

export {};
