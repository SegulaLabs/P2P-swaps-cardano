"use client";

import "./globals.css";

/**
 * Last-resort boundary for errors thrown in the root layout itself (which
 * app/error.tsx cannot catch). It must render its own <html>/<body>. Keeps the
 * user off a blank white screen with a way to reload into the fresh build.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <div
          className="card"
          style={{ maxWidth: 560, margin: "3rem auto", textAlign: "center" }}
        >
          <h2 style={{ marginTop: 0 }}>The app failed to load</h2>
          <p className="muted">
            This can happen right after an update. Reload to get the latest
            version.
          </p>
          <p style={{ display: "flex", gap: "0.5rem", justifyContent: "center" }}>
            <button
              className="btn btn-primary"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
            <button className="btn btn-ghost" onClick={() => reset()}>
              Try again
            </button>
          </p>
          {error?.message && (
            <p className="mono muted small" style={{ marginTop: "1rem" }}>
              {error.message}
            </p>
          )}
        </div>
      </body>
    </html>
  );
}
