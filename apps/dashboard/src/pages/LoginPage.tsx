import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../components/AuthProvider";
import { ErrorBox, Field } from "../components/ui";

export function LoginPage() {
  const { admin, login } = useAuth();
  const [email, setEmail] = useState("quantumxx0@gmail.com");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (admin) return <Navigate to="/treasury" replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">
          <span className="brand-mark">wU</span>
          <span>wUSDT Treasury</span>
        </div>
        <h1 className="login-title">Operations console</h1>
        <p className="muted" style={{ fontSize: 13.5, marginTop: 0, marginBottom: 20 }}>
          The whole console — mint/burn, orchestrator, wallets, loan book and records — is behind this login. Only
          authorised operators can read or change records.
        </p>

        <Field label="Admin email">
          <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" autoComplete="username" required />
        </Field>
        <Field label="Password">
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            type="password"
            autoComplete="current-password"
            required
          />
        </Field>

        <button className="btn btn-primary" type="submit" disabled={busy} style={{ width: "100%", marginTop: 6 }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>

        <ErrorBox error={error} />
      </form>
    </div>
  );
}
