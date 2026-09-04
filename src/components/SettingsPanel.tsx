import { useEffect, useState } from "react";
import type { CookieSource, CookieStatus } from "../../shared/types";

export function SettingsPanel() {
  const [source, setSource] = useState<CookieSource>("netease");
  const [cookie, setCookie] = useState("");
  const [status, setStatus] = useState<CookieStatus>("unconfigured");
  const [message, setMessage] = useState<string>();
  const [connectionMessage, setConnectionMessage] = useState<string>();
  useEffect(() => { let active = true; setMessage(undefined); setConnectionMessage(undefined); window.musicId3.getProviderCookieStatus(source).then((value) => { if (active) setStatus(value); }).catch(() => { if (active) setMessage("Unable to load Cookie status"); }); return () => { active = false; }; }, [source]);
  const save = async () => { try { await window.musicId3.setProviderCookie(source, cookie); setCookie(""); setStatus(await window.musicId3.getProviderCookieStatus(source)); setMessage(undefined); setConnectionMessage(undefined); } catch { setMessage("Unable to save Cookie"); } };
  const test = async () => { try { const result = await window.musicId3.testProviderCookie(source); setConnectionMessage(result.ok ? "Connection successful" : result.error); try { setStatus(await window.musicId3.getProviderCookieStatus(source)); } catch { setMessage("Unable to load Cookie status"); } } catch { setConnectionMessage("Cookie test failed"); } };
  const clear = async () => { try { await window.musicId3.setProviderCookie(source, ""); setCookie(""); setStatus(await window.musicId3.getProviderCookieStatus(source)); setMessage(undefined); setConnectionMessage(undefined); } catch { setMessage("Unable to clear Cookie"); } };
  const clearCache = async () => { try { await window.musicId3.clearOnlineCache(); setMessage("Online cache cleared"); } catch { setMessage("Unable to clear online cache"); } };
  return <details className="settings-panel"><summary>Settings</summary><label>Provider<select aria-label="Cookie provider" value={source} onChange={(event) => setSource(event.target.value as CookieSource)}><option value="netease">NetEase</option><option value="qq">QQ Music</option></select></label><textarea aria-label="cookie" value={cookie} onChange={(event) => setCookie(event.target.value)} placeholder="Paste Cookie" /><div className="cookie-actions"><button disabled={!cookie.trim()} onClick={save}>Save Cookie</button><button onClick={test}>Test</button><button onClick={clear}>Clear</button><span aria-label="Cookie status">{status}</span></div><button onClick={clearCache}>Clear online cache</button>{connectionMessage && <p className={connectionMessage.includes("failed") ? "error-text" : "status-text"} role="status">{connectionMessage}</p>}{message && <p className={message.includes("failed") || message.includes("Unable") ? "error-text" : "status-text"} role="status">{message}</p>}</details>;
}
