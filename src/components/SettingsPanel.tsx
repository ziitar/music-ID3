import { useEffect, useRef, useState } from "react";
import type { CookieSource, CookieStatus } from "../../shared/types";

type ProviderState = { cookie: string; status: CookieStatus; message?: string; connectionMessage?: string };
type ProviderGenerations = Record<CookieSource, number>;

export function SettingsPanel() {
  const [source, setSource] = useState<CookieSource>("netease");
  const [providers, setProviders] = useState<Record<CookieSource, ProviderState>>({ netease: { cookie: "", status: "unconfigured" }, qq: { cookie: "", status: "unconfigured" } });
  const mounted = useRef(true);
  const statusReads = useRef<ProviderGenerations>({ netease: 0, qq: 0 });
  const mutations = useRef<ProviderGenerations>({ netease: 0, qq: 0 });
  const tests = useRef<ProviderGenerations>({ netease: 0, qq: 0 });
  const cacheOperation = useRef(0);
  const update = (provider: CookieSource, patch: Partial<ProviderState>) => {
    if (!mounted.current) return;
    setProviders((current) => ({ ...current, [provider]: { ...current[provider], ...patch } }));
  };
  const refreshStatus = async (provider: CookieSource, expectedMutation?: number) => {
    const request = ++statusReads.current[provider];
    try {
      const status = await window.musicId3.getProviderCookieStatus(provider);
      if (mounted.current && statusReads.current[provider] === request && (expectedMutation === undefined || mutations.current[provider] === expectedMutation)) {
        update(provider, { status, message: undefined });
        return status;
      }
    } catch {
      if (mounted.current && statusReads.current[provider] === request && (expectedMutation === undefined || mutations.current[provider] === expectedMutation)) update(provider, { message: "Unable to load Cookie status" });
    }
  };
  const current = providers[source];

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      statusReads.current.netease += 1; statusReads.current.qq += 1;
      mutations.current.netease += 1; mutations.current.qq += 1;
      tests.current.netease += 1; tests.current.qq += 1;
      cacheOperation.current += 1;
    };
  }, []);
  useEffect(() => { update(source, { message: undefined, connectionMessage: undefined }); void refreshStatus(source); }, [source]);

  const save = async () => {
    const provider = source; const mutation = ++mutations.current[provider]; const value = providers[provider].cookie;
    statusReads.current[provider] += 1;
    try {
      await window.musicId3.setProviderCookie(provider, value);
      if (!mounted.current || mutations.current[provider] !== mutation) return;
      const status = await refreshStatus(provider, mutation);
      if (status && mounted.current && mutations.current[provider] === mutation) update(provider, { cookie: "", status, message: undefined, connectionMessage: undefined });
    } catch { if (mounted.current && mutations.current[provider] === mutation) update(provider, { message: "Unable to save Cookie" }); }
  };
  const test = async () => {
    const provider = source; const operation = ++tests.current[provider];
    try {
      const result = await window.musicId3.testProviderCookie(provider);
      if (!mounted.current || tests.current[provider] !== operation) return;
      await refreshStatus(provider);
      if (mounted.current && tests.current[provider] === operation) update(provider, { connectionMessage: result.ok ? "Connection successful" : result.error });
    } catch { if (mounted.current && tests.current[provider] === operation) update(provider, { connectionMessage: "Cookie test failed" }); }
  };
  const clear = async () => {
    const provider = source; const mutation = ++mutations.current[provider];
    statusReads.current[provider] += 1;
    try {
      await window.musicId3.setProviderCookie(provider, "");
      if (!mounted.current || mutations.current[provider] !== mutation) return;
      const status = await refreshStatus(provider, mutation);
      if (status && mounted.current && mutations.current[provider] === mutation) update(provider, { cookie: "", status, message: undefined, connectionMessage: undefined });
    } catch { if (mounted.current && mutations.current[provider] === mutation) update(provider, { message: "Unable to clear Cookie" }); }
  };
  const clearCache = async () => {
    const provider = source; const operation = ++cacheOperation.current;
    try { await window.musicId3.clearOnlineCache(); if (mounted.current && cacheOperation.current === operation) update(provider, { message: "Online cache cleared" }); }
    catch { if (mounted.current && cacheOperation.current === operation) update(provider, { message: "Unable to clear online cache" }); }
  };

  return <details className="settings-panel"><summary>Settings</summary><label>Provider<select aria-label="Cookie provider" value={source} onChange={(event) => setSource(event.target.value as CookieSource)}><option value="netease">NetEase</option><option value="qq">QQ Music</option></select></label><textarea aria-label="cookie" value={current.cookie} onChange={(event) => update(source, { cookie: event.target.value })} placeholder="Paste Cookie" /><div className="cookie-actions"><button disabled={!current.cookie.trim()} onClick={() => void save()}>Save Cookie</button><button onClick={() => void test()}>Test</button><button onClick={() => void clear()}>Clear</button><span aria-label="Cookie status">{current.status}</span></div><button onClick={() => void clearCache()}>Clear online cache</button>{current.connectionMessage && <p className={current.connectionMessage.includes("failed") ? "error-text" : "status-text"} role="status">{current.connectionMessage}</p>}{current.message && <p className={current.message.includes("failed") || current.message.includes("Unable") ? "error-text" : "status-text"} role="status">{current.message}</p>}</details>;
}
