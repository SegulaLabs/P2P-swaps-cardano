import { explorerTxUrl } from "@/lib/explorer";

/** Small "view on Cardanoscan" link for any on-chain transaction hash. */
export function ExplorerLink({
  txHash,
  children = "Cardanoscan ↗",
  className = "linklike",
  title = "View on Cardanoscan",
}: {
  txHash: string;
  children?: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <a
      href={explorerTxUrl(txHash)}
      target="_blank"
      rel="noreferrer"
      className={className}
      title={title}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </a>
  );
}
