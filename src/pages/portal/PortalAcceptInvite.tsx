import { useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Brain, Loader2, CheckCircle2 } from "lucide-react";
import { Helmet } from "react-helmet-async";

export default function PortalAcceptInvite() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [done, setDone] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const tokenPresent = !!token && token.length <= 256;

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting.current || !tokenPresent) return;
    const fields = new FormData(event.currentTarget);
    const email = String(fields.get("email") || "").trim().toLowerCase();
    const password = String(fields.get("password") || "");
    setError("");
    setMessage("");
    if (mode === "signup" && password !== fields.get("confirm")) {
      setError("As senhas não coincidem.");
      return;
    }
    submitting.current = true;
    setBusy(true);
    try {
      const response = mode === "signup"
        ? await supabase.auth.signUp({
            email, password,
            options: { emailRedirectTo: window.location.origin + "/portal/aceitar-convite/" + encodeURIComponent(token!) },
          })
        : await supabase.auth.signInWithPassword({ email, password });
      if (response.error) {
        setError(mode === "signup"
          ? "Não foi possível criar a conta. Se já tem cadastro, escolha Entrar. Confira também os requisitos da senha."
          : "Não foi possível entrar. Confira o e-mail, a senha e a confirmação do seu e-mail.");
        return;
      }
      // A user object alone is not proof of an authenticated session.
      if (!response.data.session) {
        setMessage("Confira seu e-mail para confirmar o cadastro. Depois, volte a este convite e entre com sua senha. Se já tinha uma conta, escolha Entrar.");
        setMode("login");
        return;
      }
      const { data: identity, error: identityError } = await supabase.auth.getUser();
      if (identityError || !identity.user || identity.user.email?.toLowerCase() !== email) {
        setError("Não foi possível confirmar sua sessão. Entre novamente.");
        return;
      }
      const { data, error: linkError } = await supabase.rpc("accept_patient_invite", {
        _token: token!, _user_id: identity.user.id,
      });
      if (linkError || !data) {
        setError("Não foi possível aceitar o convite. Use o e-mail confirmado que recebeu o convite. Se ele expirou ou já foi usado, peça um novo ao profissional.");
        return;
      }
      setDone(true);
    } catch {
      setError("Não foi possível concluir agora. Verifique sua conexão e tente novamente.");
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-hero flex items-center justify-center p-4">
      <Helmet><title>Ativar acesso — Portal do Paciente</title><meta name="referrer" content="no-referrer" /></Helmet>
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center mb-6 space-y-3">
          <Brain className="h-10 w-10 text-primary" />
          <h1 className="text-2xl font-bold text-gradient-primary">Portal do Paciente</h1>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>{done ? "Acesso ativado" : "Aceitar convite"}</CardTitle>
            <CardDescription>Use o mesmo e-mail em que recebeu o convite do seu profissional.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!tokenPresent ? <p role="alert">Convite inválido. Peça um novo link ao seu profissional.</p>
              : done ? <>
                <CheckCircle2 className="h-10 w-10 text-emerald-500" />
                <p>Seu acesso foi ativado com sucesso.</p>
                <Button onClick={() => navigate("/portal/dashboard")}>Abrir meu portal</Button>
              </> : <>
                <div className="flex gap-2">
                  <Button type="button" variant={mode === "login" ? "default" : "outline"} disabled={busy} onClick={() => setMode("login")}>Entrar</Button>
                  <Button type="button" variant={mode === "signup" ? "default" : "outline"} disabled={busy} onClick={() => setMode("signup")}>Criar conta</Button>
                </div>
                {message && <p role="status" className="text-sm">{message}</p>}
                {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
                <form onSubmit={handleSubmit} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="invite-email">E-mail do convite</Label>
                    <Input id="invite-email" name="email" type="email" autoComplete="email" required disabled={busy} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="invite-password">{mode === "signup" ? "Nova senha" : "Senha"}</Label>
                    <Input id="invite-password" name="password" type="password" autoComplete={mode === "signup" ? "new-password" : "current-password"} minLength={mode === "signup" ? 6 : undefined} required disabled={busy} />
                  </div>
                  {mode === "signup" && <div className="space-y-2">
                    <Label htmlFor="invite-confirm">Confirme a senha</Label>
                    <Input id="invite-confirm" name="confirm" type="password" autoComplete="new-password" minLength={6} required disabled={busy} />
                  </div>}
                  <Button type="submit" variant="hero" className="w-full" disabled={busy}>
                    {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {mode === "signup" ? "Cadastrar e continuar" : "Entrar e aceitar convite"}
                  </Button>
                </form>
              </>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
