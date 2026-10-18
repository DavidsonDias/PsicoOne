import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { toast } from "sonner";
import { Calendar, Link2, Unlink, RefreshCw, Loader2, CheckCircle2, Mail } from "lucide-react";

interface GoogleCalendarPrefs {
  connected: boolean;
  google_email?: string;
  sync_enabled?: boolean;
  auto_create?: boolean;
  auto_update?: boolean;
  sync_new_only?: boolean;
}

interface CalendarSyncResult {
  synced?: number;
  created?: number;
  updated?: number;
  recreated?: number;
  failed?: number;
  error?: string;
}

export function GoogleCalendarSettings() {
  const [prefs, setPrefs] = useState<GoogleCalendarPrefs>({ connected: false });
  const [statusError, setStatusError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [updatingPrefs, setUpdatingPrefs] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setStatusError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Session unavailable");

      const { data, error } = await supabase.functions.invoke("google-calendar-auth", {
        body: { action: "status" },
      });

      if (error || !data || typeof data.connected !== "boolean") throw new Error("Status unavailable");
      setPrefs(data);
    } catch (err) {
      setStatusError("Não foi possível verificar o Google Agenda. A integração pode estar temporariamente indisponível. Tente novamente em instantes.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();

    // Check for OAuth callback code
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code && state) {
      handleOAuthCallback(code, state);
      // Clean URL
      url.searchParams.delete("code");
      url.searchParams.delete("state");
      url.searchParams.delete("scope");
      window.history.replaceState({}, "", url.pathname);
    }
  }, [loadStatus]);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const redirectUri = `${window.location.origin}/configuracoes`;

      const { data, error } = await supabase.functions.invoke("google-calendar-auth", {
        body: { action: "get_auth_url", redirect_uri: redirectUri },
      });

      if (error || !data?.url) {
        toast.error("Erro ao iniciar conexão com Google");
        return;
      }

      const target = new URL(data.url);
      if (target.origin !== 'https://accounts.google.com' || target.pathname !== '/o/oauth2/v2/auth' || !/^[0-9a-f]{64}$/.test(data.state) || target.searchParams.get('state') !== data.state || typeof data.user_id !== 'string') throw new Error('Invalid OAuth response');
      sessionStorage.setItem('psicoone:calendar-oauth', JSON.stringify({ state: data.state, user: data.user_id, redirect: redirectUri, expires: Date.now() + 600000 }));
      window.location.href = target.href;
    } catch (err) {
      toast.error("Erro ao conectar com Google");
    } finally {
      setConnecting(false);
    }
  };

  const handleOAuthCallback = async (code: string, state: string) => {
    setConnecting(true);
    try {
      const redirectUri = `${window.location.origin}/configuracoes`;
      const pending = sessionStorage.getItem('psicoone:calendar-oauth');
      sessionStorage.removeItem('psicoone:calendar-oauth');
      if (!pending) throw new Error('Missing OAuth attempt');
      const attempt = JSON.parse(pending);
      const { data: identity, error: identityError } = await supabase.auth.getUser();
      if (identityError || !identity.user || attempt.user !== identity.user.id || attempt.state !== state || attempt.redirect !== redirectUri || !Number.isFinite(attempt.expires) || attempt.expires <= Date.now()) throw new Error('Invalid OAuth attempt');
      const { data, error } = await supabase.functions.invoke("google-calendar-auth", {
        body: { action: "exchange_code", code, state, redirect_uri: redirectUri },
      });

      if (error || !data?.success) {
        toast.error("Falha na autenticação com Google Calendar");
        return;
      }

      toast.success(`Google Calendar conectado! (${data.email})`);
      await loadStatus();
    } catch (err) {
      toast.error("Erro ao finalizar conexão");
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      const { error } = await supabase.functions.invoke("google-calendar-auth", {
        body: { action: "disconnect" },
      });

      if (error) {
        toast.error("Erro ao desconectar");
        return;
      }

      setPrefs({ connected: false });
      toast.success("Google Calendar desconectado");
    } catch (err) {
      toast.error("Erro ao desconectar");
    } finally {
      setDisconnecting(false);
    }
  };

  const handleUpdatePrefs = async (key: string, value: boolean) => {
    const newPrefs = { ...prefs, [key]: value };
    setUpdatingPrefs(true);

    try {
      const { data, error } = await supabase.functions.invoke("google-calendar-auth", {
        body: {
          action: "update_preferences",
          sync_enabled: newPrefs.sync_enabled,
          auto_create: newPrefs.auto_create,
          auto_update: newPrefs.auto_update,
          sync_new_only: newPrefs.sync_new_only,
        },
      });
      if (error || data?.success !== true) throw new Error("Preferences not saved");
      setPrefs(newPrefs);
    } catch (err) {
      toast.error("Erro ao atualizar preferências");
    } finally {
      setUpdatingPrefs(false);
    }
  };

  const handleSyncAll = async () => {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke("google-calendar-sync", {
        body: { action: "sync_all" },
      });

      const result = data as CalendarSyncResult | null;
      if (error || result?.error) {
        toast.error(result?.error || "Erro ao sincronizar agenda. Reconecte sua conta e tente novamente.");
        return;
      }

      const synced = result?.synced || 0;
      const failed = result?.failed || 0;
      const details = [
        `${result?.created || 0} criados`,
        `${result?.updated || 0} atualizados`,
        `${result?.recreated || 0} recriados`,
      ].join(" · ");

      if (failed > 0) {
        toast.warning(`${synced} sincronizados · ${failed} falharam`, { description: details });
      } else if (synced === 0) {
        toast.info("Agenda já está sincronizada", { description: "Nenhuma alteração pendente foi encontrada." });
      } else {
        toast.success(`${synced} agendamento(s) sincronizado(s)`, { description: details });
      }
    } catch (err) {
      toast.error("Erro ao sincronizar");
    } finally {
      setSyncing(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Calendar className="h-5 w-5 text-primary" />
          </div>
          <div className="flex-1">
            <CardTitle className="text-lg">Google Calendar</CardTitle>
            <CardDescription>Sincronize seus agendamentos com o Google Agenda</CardDescription>
          </div>
          {!statusError && prefs.connected && (
            <Badge variant="default" className="gap-1">
              <CheckCircle2 className="h-3 w-3" />
              Conectado
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {statusError ? (
          <div role="alert" className="space-y-3">
            <p className="text-sm text-muted-foreground">{statusError}</p>
            <Button variant="outline" onClick={loadStatus}>Tentar novamente</Button>
          </div>
        ) : !prefs.connected ? (
          <div className="text-center py-6 space-y-4">
            <div className="h-16 w-16 mx-auto rounded-full bg-muted flex items-center justify-center">
              <Calendar className="h-8 w-8 text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium">Conecte sua conta Google</p>
              <p className="text-sm text-muted-foreground mt-1">
                Seus agendamentos serão sincronizados automaticamente com o Google Calendar.
              </p>
            </div>
            <Button onClick={handleConnect} disabled={connecting} className="gap-2">
              {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              Conectar com Google Agenda
            </Button>
          </div>
        ) : (
          <>
            {/* Connected account info */}
            <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/30 border">
              <Mail className="h-4 w-4 text-muted-foreground" />
              <div className="flex-1">
                <p className="text-sm font-medium">{prefs.google_email}</p>
                <p className="text-xs text-muted-foreground">Conta conectada</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="gap-1 text-destructive hover:text-destructive"
              >
                {disconnecting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Unlink className="h-3 w-3" />}
                Desconectar
              </Button>
            </div>

            <Separator />

            {/* Sync preferences */}
            <div className="space-y-4">
              <h4 className="text-sm font-medium">Preferências de Sincronização</h4>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Sincronização automática</Label>
                  <p className="text-xs text-muted-foreground">Ativar sincronização com Google Calendar</p>
                </div>
                <Switch
                  disabled={updatingPrefs}
                  checked={prefs.sync_enabled ?? true}
                  onCheckedChange={(v) => handleUpdatePrefs("sync_enabled", v)}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Criar eventos automaticamente</Label>
                  <p className="text-xs text-muted-foreground">Novos agendamentos criam evento no Google</p>
                </div>
                <Switch
                  disabled={updatingPrefs}
                  checked={prefs.auto_create ?? true}
                  onCheckedChange={(v) => handleUpdatePrefs("auto_create", v)}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Atualizar eventos automaticamente</Label>
                  <p className="text-xs text-muted-foreground">Alterações são refletidas no Google</p>
                </div>
                <Switch
                  disabled={updatingPrefs}
                  checked={prefs.auto_update ?? true}
                  onCheckedChange={(v) => handleUpdatePrefs("auto_update", v)}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Sincronizar apenas novos eventos</Label>
                  <p className="text-xs text-muted-foreground">Não sincronizar agendamentos passados</p>
                </div>
                <Switch
                  disabled={updatingPrefs}
                  checked={prefs.sync_new_only ?? false}
                  onCheckedChange={(v) => handleUpdatePrefs("sync_new_only", v)}
                />
              </div>
            </div>

            <Separator />

            {/* Manual sync */}
            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={handleSyncAll}
              disabled={syncing}
            >
              {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              {syncing ? "Sincronizando..." : "Sincronizar Agenda Agora"}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

