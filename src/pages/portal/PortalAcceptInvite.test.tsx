import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { HelmetProvider } from "react-helmet-async";
const mock = vi.hoisted(() => ({ signUp: vi.fn(), signInWithPassword: vi.fn(), getUser: vi.fn(), rpc: vi.fn(), from: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { auth: mock, rpc: mock.rpc, from: mock.from } }));
import PortalAcceptInvite from "./PortalAcceptInvite";
beforeEach(() => {
  vi.resetAllMocks();
  mock.signInWithPassword.mockResolvedValue({ data: { session: {} }, error: null });
  mock.getUser.mockResolvedValue({ data: { user: { id: "user", email: "recipient@example.invalid" } }, error: null });
  mock.rpc.mockResolvedValue({ data: "patient", error: null });
});
afterEach(cleanup);
function open() {
 render(<HelmetProvider><MemoryRouter initialEntries={["/portal/aceitar-convite/synthetic"]}><Routes><Route path="/portal/aceitar-convite/:token" element={<PortalAcceptInvite />} /></Routes></MemoryRouter></HelmetProvider>);
}
function fill() {
 fireEvent.change(screen.getByLabelText("E-mail do convite"), { target: { value: "recipient@example.invalid" } });
 fireEvent.change(screen.getByLabelText("Senha"), { target: { value: "synthetic-password" } });
}
it("does not read the invitation table and accepts only after verified login", async () => {
 open(); fill(); fireEvent.click(screen.getByText("Entrar e aceitar convite"));
 await screen.findByText("Seu acesso foi ativado com sucesso.");
 expect(mock.from).not.toHaveBeenCalled();
 expect(mock.signUp).not.toHaveBeenCalled();
 expect(mock.rpc).toHaveBeenCalledWith("accept_patient_invite", { _token: "synthetic", _user_id: "user" });
});
it("waits for confirmation when signup returns a user without a session", async () => {
 mock.signUp.mockResolvedValue({ data: { user: { id: "unconfirmed" }, session: null }, error: null });
 open(); fireEvent.click(screen.getByText("Criar conta"));
 fireEvent.change(screen.getByLabelText("E-mail do convite"), { target: { value: "recipient@example.invalid" } });
 fireEvent.change(screen.getByLabelText("Nova senha"), { target: { value: "synthetic-password" } });
 fireEvent.change(screen.getByLabelText("Confirme a senha"), { target: { value: "synthetic-password" } });
 fireEvent.click(screen.getByText("Cadastrar e continuar"));
 await screen.findByRole("status");
 expect(mock.rpc).not.toHaveBeenCalled();
 expect(mock.signInWithPassword).not.toHaveBeenCalled();
 expect(mock.signUp.mock.calls[0][0].options.emailRedirectTo).toContain("/portal/aceitar-convite/synthetic");
});
it("does not link a different authenticated account", async () => {
 mock.getUser.mockResolvedValue({ data: { user: { id: "other", email: "other@example.invalid" } }, error: null });
 open(); fill(); fireEvent.click(screen.getByText("Entrar e aceitar convite"));
 await screen.findByRole("alert"); expect(mock.rpc).not.toHaveBeenCalled();
});
it("does not report success when acceptance fails", async () => {
 mock.rpc.mockResolvedValue({ data: null, error: { message: "rejected" } });
 open(); fill(); fireEvent.click(screen.getByText("Entrar e aceitar convite"));
 await screen.findByRole("alert"); expect(screen.queryByText("Seu acesso foi ativado com sucesso.")).toBeNull();
});
it("does not create an account on failed login", async () => {
 mock.signInWithPassword.mockResolvedValue({ data: {}, error: { message: "invalid" } });
 open(); fill(); fireEvent.click(screen.getByText("Entrar e aceitar convite"));
 await screen.findByRole("alert"); expect(mock.signUp).not.toHaveBeenCalled(); expect(mock.rpc).not.toHaveBeenCalled();
});
it("shows connection errors and permits retry", async () => {
 mock.signInWithPassword.mockRejectedValue(new Error("offline"));
 open(); fill(); fireEvent.click(screen.getByText("Entrar e aceitar convite"));
 await screen.findByRole("alert");
 await waitFor(() => expect(screen.getByText("Entrar e aceitar convite")).not.toBeDisabled());
});
