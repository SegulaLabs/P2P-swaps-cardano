"use client";

import { useEffect } from "react";

/**
 * Page-level error boundary. Without this, any client render/chunk-load error
 * (e.g. a stale tab requesting chunks a rebuild has purged) leaves a blank
 * white screen. Here we show what happened and a one-click reload that fetches
 * the fresh HTML + current chunks.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("UI error boundary caught:", error);
  }, [error]);

  const looksLikeStaleChunk = /chunk|import|Loading|dynamically imported module/i.test(
    error.message
  );

  return (
    <div className="card" style={{ maxWidth: 560, margin: "3rem auto", textAlign: "center" }}>
      <h2 style={{ marginTop: 0 }}>Something went wrong loading the page</h2>
      <p className="muted">
        {looksLikeStaleChunk
          ? "The app was updated in the background. Reload to get the latest version."
          : "An unexpected error occurred while rendering this page."}
      </p>
      <p style={{ display: "flex", gap: "0.5rem", justifyContent: "center" }}>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload
        </button>
        <button className="btn btn-ghost" onClick={() => reset()}>
          Try again
        </button>
      </p>
      {error.message && (
        <details className="tx-details" style={{ marginTop: "1rem", textAlign: "left" }}>
          <summary>Error details</summary>
          <code className="cbor">
            {error.message}
            {error.digest ? `\n\ndigest: ${error.digest}` : ""}
          </code>
        </details>
      )}
    </div>
  );
}
