/**
 * Always-visible network indicator. The MVP is preprod-only; any other value
 * renders a loud error rather than pretending.
 */
export function NetworkBadge() {
  const network = process.env.NEXT_PUBLIC_CARDANO_NETWORK ?? "preprod";
  if (network !== "preprod") {
    return <span className="network-badge error">MISCONFIGURED: {network}</span>;
  }
  return <span className="network-badge">preprod</span>;
}
