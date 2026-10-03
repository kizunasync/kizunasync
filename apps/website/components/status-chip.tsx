// MARK: - StatusChip

/**
 * Public release-status chip. Docs are the contract (@../../../GOVERNANCE.md);
 * the chip only names the phase. Surrounding copy owns the details. Server
 * component; colors come from theme tokens only.
 */
export function StatusChip() {
  return (
    <span
      className="border-site-accent-dim text-site-accent inline-flex items-center rounded-full border px-2.5 py-0.5 font-mono text-[10px] tracking-wide whitespace-nowrap"
    >
      Alpha
    </span>
  )
}
