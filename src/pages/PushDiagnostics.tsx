import { useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BellRing, CheckCircle2, XCircle, Loader2, Send, RefreshCw } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { usePushSubscription } from "@/hooks/usePushSubscription";
import { VAPID_PUBLIC_KEY } from "@/lib/push-config";
import { toast } from "sonner";
import { formatClinicDateTime } from "@/lib/clinic-datetime";

interface DiagState {
  permission: NotificationPermission | "unsupported";
  swStatus: "active" | "installing" | "redundant" | "none";
  subscribed: boolean;
  endpoint: string | null;
  vapidConfigured: boolean;
  userAgent: string;
  isStandalone: boolean;
}

export default function PushDiagnostics() {
  const { supported, subscribed, loading, subscribe, unsubscribe } = usePushSubscription();
  const [diag, setDiag] = useState<DiagState | null>(null);
  const [lastSends, setLastSends] = useState<any[]>([]);
  const [sending, setSending] = useState(false);

  const refresh = async () => {
    const isStandalone =
      window.matchMedia?.("(display-mode: standalone)").matches ||
      // @ts-ignore iOS
      window.navigator.standalone === true;
    let permission: NotificationPermission | "unsupported" = "unsupported";
    if (typeof Notification !== "undefined") permission = Notification.permission;
    let swStatus: DiagState["swStatus"] = "none";
    let endpoint: string | null = null;
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration("/push-sw.js");
      if (reg) {
        if (reg.active) swStatus = "active";
        else if (reg.installing) swStatus = "installing";
        else swStatus = "redundant";
        const sub = await reg.pushManager.getSubscription();
        endpoint = sub?.endpoint ?? null;
      }
    }
    setDiag({
      permission,
      swStatus,
      subscribed,
      endpoint,
      vapidConfigured: Boolean(VAPID_PUBLIC_KEY),
      userAgent: navigator.userAgent,
      isStandalone,
    });

    // Last sends from notifications inbox (proxy for push activity)
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      const { data } = await supabase
        .from("notifications")
        .select("id, title, message, created_at, category")
        .eq("user_id", session.user.id)
        .order("created_at", { ascending: false })
        .limit(5);
      setLastSends(data || []);
    }
  };

  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [subscribed]);

  const sendTest = async () => {
    setSending(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Sessão expirada");
      const { data, error } = await supabase.functions.invoke("send-push", {
        body: {
          user_ids: [session.user.id],
          title: "🔔 Teste de notificação",
          body: "Se você está lendo isto, o push está funcionando neste dispositivo.",
          url: "/configuracoes/diagnostico-push",
          tag: "diag-test",
        },
      });
      if (error) {
        const detail = await error.context?.json?.().catch(() => null);
        throw new Error(detail?.error || "Não foi possível enviar a notificação de teste.");
      }
      if (!data?.ok || !data?.sent) throw new Error(data?.error || "Nenhuma notificação foi entregue ao provedor.");
      toast.success("Notificação de teste enviada. Verifique seu dispositivo.");
      setTimeout(refresh, 1500);
    } catch (e: any) {
      toast.error(`Falha: ${e.message || e}`);
    } finally {
      setSending(false);
    }
  };

  const Row = ({ label, ok, value }: { label: string; ok: boolean; value: string }) => (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-border/40 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-sm font-mono break-all text-right">{value}</span>
        {ok ? <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" /> : <XCircle className="h-4 w-4 text-destructive shrink-0" />}
      </div>
    </div>
  );

  return (
    <>
      <Helmet><title>Diagnóstico Push — PsicoOne</title></Helmet>
      <AppLayout>
        <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-6">
          <header className="flex items-start justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
                <BellRing className="h-6 w-6 text-primary" /> Diagnóstico de Notificações Push
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Verifique se este dispositivo está apto a receber alertas em tempo real.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={refresh} className="gap-2">
              <RefreshCw className="h-4 w-4" /> Atualizar
            </Button>
          </header>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Status do dispositivo</CardTitle>
              <CardDescription>Snapshot do navegador / PWA atual.</CardDescription>
            </CardHeader>
            <CardContent>
              {!diag ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Coletando informações…
                </div>
              ) : (
                <div className="space-y-1">
                  <Row label="Permissão de notificação" ok={diag.permission === "granted"} value={diag.permission} />
                  <Row label="Service Worker" ok={diag.swStatus === "active"} value={diag.swStatus} />
                  <Row label="Subscription ativa" ok={diag.subscribed} value={diag.subscribed ? "sim" : "não"} />
                  <Row label="VAPID configurado" ok={diag.vapidConfigured} value={diag.vapidConfigured ? "sim" : "não"} />
                  <Row label="Modo standalone (PWA instalado)" ok={diag.isStandalone} value={diag.isStandalone ? "sim" : "não"} />
                  <Row
                    label="Endpoint"
                    ok={!!diag.endpoint}
                    value={diag.endpoint ? diag.endpoint.replace(/^(https?:\/\/[^/]+).*$/, "$1/…") : "—"}
                  />
                  <div className="pt-2">
                    <p className="text-xs text-muted-foreground break-all">{diag.userAgent}</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Ações</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col sm:flex-row gap-3">
              {!subscribed ? (
                <Button onClick={subscribe} disabled={loading || !supported} className="gap-2">
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellRing className="h-4 w-4" />}
                  Ativar push neste dispositivo
                </Button>
              ) : (
                <Button variant="outline" onClick={unsubscribe} disabled={loading} className="gap-2">
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                  Desativar push
                </Button>
              )}
              <Button onClick={sendTest} disabled={sending || !subscribed} variant="secondary" className="gap-2">
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Enviar notificação de teste
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Últimos avisos registrados na sua conta</CardTitle>
            </CardHeader>
            <CardContent>
              {lastSends.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nenhuma notificação recente.</p>
              ) : (
                <ul className="space-y-2">
                  {lastSends.map((n) => (
                    <li key={n.id} className="flex items-start justify-between gap-3 border-b border-border/40 pb-2 last:border-0">
                      <div>
                        <p className="text-sm font-medium">{n.title}</p>
                        <p className="text-xs text-muted-foreground">{n.message}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <Badge variant="outline" className="text-xs">{n.category || "—"}</Badge>
                        <p className="text-[10px] text-muted-foreground mt-1">{formatClinicDateTime(n.created_at)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {!supported && (
            <p className="text-xs text-muted-foreground">
              Push indisponível neste contexto. Para funcionar no celular, instale o PsicoOne como app
              (Compartilhar → Adicionar à tela inicial no iPhone, ou menu do navegador no Android).
            </p>
          )}
        </div>
      </AppLayout>
    </>
  );
}
