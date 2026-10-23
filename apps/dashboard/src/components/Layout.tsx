import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "./AuthProvider";

const LINKS = [
  { to: "/treasury", label: "Treasury" },
  { to: "/orchestrator", label: "Orchestrator" },
  { to: "/wallets", label: "Wallets" },
  { to: "/loans", label: "Loans" },
  { to: "/transactions", label: "Transactions" },
];

export function Layout() {
  const { admin, logout } = useAuth();

  return (
    <>
      <header className="nav">
        <div className="nav-inner">
          <div className="brand">
            <span className="brand-mark">wU</span>
            <span>wUSDT Treasury Platform</span>
          </div>

          <nav className="nav-links">
            {LINKS.map((link) => (
              <NavLink key={link.to} to={link.to} className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
                {link.label}
              </NavLink>
            ))}
          </nav>

          <div className="nav-user">
            <span>{admin?.email}</span>
            <button
              className="btn btn-ghost"
              type="button"
              onClick={() => {
                void logout();
              }}
            >
              Log out
            </button>
          </div>
        </div>
      </header>

      <main className="page">
        <Outlet />
      </main>
    </>
  );
}
