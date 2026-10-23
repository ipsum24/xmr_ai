import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Admin } from "../lib/api";

interface AuthState {
  admin: Admin | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: () => api.get<{ admin: Admin }>("/api/auth/me"),
    retry: false,
  });

  const loginMutation = useMutation({
    mutationFn: (credentials: { email: string; password: string }) => api.post("/api/auth/login", credentials),
  });

  const logoutMutation = useMutation({
    mutationFn: () => api.post("/api/auth/logout"),
  });

  const value = useMemo<AuthState>(
    () => ({
      admin: meQuery.data?.admin ?? null,
      loading: meQuery.isLoading,
      login: async (email, password) => {
        await loginMutation.mutateAsync({ email, password });
        await queryClient.invalidateQueries();
      },
      logout: async () => {
        await logoutMutation.mutateAsync();
        queryClient.clear();
      },
    }),
    [meQuery.data, meQuery.isLoading, loginMutation, logoutMutation, queryClient],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}
