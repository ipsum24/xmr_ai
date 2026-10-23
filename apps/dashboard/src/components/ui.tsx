import type { ReactNode } from "react";
import type { TransactionRecord } from "../lib/api";

export function Panel({
  title,
  hint,
  children,
  white = true,
}: {
  title?: string;
  hint?: string;
  children: ReactNode;
  white?: boolean;
}) {
  return (
    <section className={`panel${white ? " panel-white" : ""}`}>
      {title && <h2 className="panel-title">{title}</h2>}
      {hint && <p className="panel-hint">{hint}</p>}
      {children}
    </section>
  );
}

export function Stat({ label, value, small = false }: { label: string; value: ReactNode; small?: boolean }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value${small ? " small" : ""}`}>{value}</div>
    </div>
  );
}

export function Badge({ kind = "neutral", children }: { kind?: "neutral" | "gold" | "success" | "danger" | "info"; children: ReactNode }) {
  return <span className={`badge badge-${kind}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: TransactionRecord["status"] }) {
  if (status === "confirmed") return <Badge kind="success">confirmed</Badge>;
  if (status === "failed") return <Badge kind="danger">failed</Badge>;
  if (status === "broadcasting") {
    return (
      <Badge kind="gold">
        <span className="spinner" />
        broadcasting
      </Badge>
    );
  }
  return <Badge kind="neutral">pending broadcast</Badge>;
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return <div className="error-box">{message}</div>;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

export function Bar({ bps }: { bps: number }) {
  const clamped = Math.max(0, Math.min(100, bps / 100));
  return (
    <div className="bar">
      <div className="bar-fill" style={{ width: `${clamped}%` }} />
    </div>
  );
}
