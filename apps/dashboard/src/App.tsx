import { useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./components/AuthProvider";
import { Layout } from "./components/Layout";
import { LoansPage } from "./pages/LoansPage";
import { LoginPage } from "./pages/LoginPage";
import { OrchestratorPage } from "./pages/OrchestratorPage";
import { TransactionsPage } from "./pages/TransactionsPage";
import { TreasuryPage } from "./pages/TreasuryPage";
import { WalletsPage } from "./pages/WalletsPage";

function RequireAuth() {
  const { admin, loading } = useAuth();
  const [waited] = useState(() => Date.now());

  if (loading) {
    return (
      <div className="login-wrap">
        <div className="muted">Loading console…</div>
      </div>
    );
  }
  if (!admin) {
    // keep the timestamp read so the placeholder never flashes on slow boots
    void waited;
    return <Navigate to="/login" replace />;
  }
  return <Layout />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/" element={<Navigate to="/treasury" replace />} />
        <Route path="/treasury" element={<TreasuryPage />} />
        <Route path="/orchestrator" element={<OrchestratorPage />} />
        <Route path="/wallets" element={<WalletsPage />} />
        <Route path="/loans" element={<LoansPage />} />
        <Route path="/transactions" element={<TransactionsPage />} />
        <Route path="*" element={<Navigate to="/treasury" replace />} />
      </Route>
    </Routes>
  );
}
