import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { VAPID_PUBLIC_KEY } from "@/lib/push-config";

/**
 * Web Push subscription hook (PWA).
 * Requires a VAPID public key — set VITE_VAPID_PUBLIC_KEY env to enable.
 * Falls back gracefully when the browser does not support PushManager
 * or when running inside the Lovable preview iframe.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function isPreview() {
  if (typeof window === "undefined") return true;
  const h = window.location.hostname;
  return (
    h.startsWith("id-preview--") ||
    h.startsWith("preview--") ||
    h.endsWith(".lovableproject.com") ||
    h.endsWith(".lovableproject-dev.com") ||
    window.self !== window.top
  );
}

export function usePushSubscription() {
  const [supported, setSupported] = useState(false);
  const [subscribed, setSubscribed] = useState(false);
  const [loading, setLoading] = useState(false);
  const vapid = VAPID_PUBLIC_KEY;

  useEffect(() => {
    const ok =
      typeof window !== "undefined" &&
      "serviceWorker" in navigator &&
      "PushManager" in window &&
      !isPreview() &&
      !!vapid;
    setSupported(ok);
    if (ok) {
      navigator.serviceWorker.getRegistration("/").then(async (reg) => {
        const sub = await reg?.pushManager.getSubscription();
        const key = sub?.options.applicationServerKey;
        const expected = urlBase64ToUint8Array(vapid);
        const matches = key && key.byteLength === expected.length && new Uint8Array(key).every((b, i) => b === expected[i]);
        if (!sub || !matches) { setSubscribed(false); return; }
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) { setSubscribed(false); return; }
        const { data, error } = await supabase.from("push_subscriptions").select("id").eq("endpoint", sub.endpoint).eq("user_id", session.user.id).maybeSingle();
        setSubscribed(!error && !!data);
      });
    }
  }, [vapid]);

  const subscribe = useCallback(async () => {
    if (!supported || !vapid) {
      toast.error("Push notifications indisponíveis neste navegador.");
      return;
    }
    setLoading(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        toast.error("Permissão de notificação negada");
        return;
      }
      // Use the PWA worker, which also imports the push handlers.
      await navigator.serviceWorker.register("/sw.js");
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      const expectedKey = urlBase64ToUint8Array(vapid);
      const actualKey = existing?.options.applicationServerKey;
      if (existing && (!actualKey || new Uint8Array(actualKey).some((b, i) => b !== expectedKey[i]) || actualKey.byteLength !== expectedKey.length)) {
        await existing.unsubscribe();
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // Some mobile browsers (notably Android Chrome) reject ArrayBuffer
        // — pass the Uint8Array directly per the Web Push spec.
        applicationServerKey: urlBase64ToUint8Array(vapid) as unknown as BufferSource,
      });
      const json: any = sub.toJSON();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Sessão expirada");
      const { error } = await supabase.from("push_subscriptions").upsert(
        {
          user_id: session.user.id,
          endpoint: json.endpoint,
          p256dh: json.keys?.p256dh ?? "",
          auth: json.keys?.auth ?? "",
          user_agent: navigator.userAgent,
        },
        { onConflict: "endpoint" }
      );
      if (error) throw error;
      setSubscribed(true);
      toast.success("Notificações push ativadas");
    } catch (e: any) {
      console.error(e);
      toast.error("Falha ao ativar push");
    } finally {
      setLoading(false);
    }
  }, [supported, vapid]);

  const unsubscribe = useCallback(async () => {
    setLoading(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
        await sub.unsubscribe();
      }
      setSubscribed(false);
      toast.success("Push desativado");
    } finally {
      setLoading(false);
    }
  }, []);

  return { supported, subscribed, loading, subscribe, unsubscribe };
}
