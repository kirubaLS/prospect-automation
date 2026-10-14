import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

// ---- toasts ----
const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((text, kind = '') => {
    const id = Math.random().toString(36).slice(2);
    setItems((s) => [...s, { id, text, kind }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), kind === 'err' ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">{items.map((t) => <div key={t.id} className={'toast ' + t.kind}>{t.text}</div>)}</div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---- confirm modal ----
const ConfirmCtx = createContext(async () => false);
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const ask = useCallback((opts) => new Promise((resolve) => setState({ ...opts, resolve })), []);
  const close = (v) => { state && state.resolve(v); setState(null); };
  useEffect(() => { if (!state) return; const k = (e) => { if (e.key === 'Escape') close(false); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); });
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {state && (
        <div className="modal-bg" onClick={() => close(false)}>
          <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3>{state.title}</h3>
            <p>{state.body}</p>
            <div className="row">
              <button className="btn secondary" onClick={() => close(false)}>Cancel</button>
              <button className={'btn ' + (state.danger ? 'danger' : '')} autoFocus onClick={() => close(true)}>{state.ok || 'Confirm'}</button>
            </div>
          </div>
        </div>
      )}
    </ConfirmCtx.Provider>
  );
}
export const useConfirm = () => useContext(ConfirmCtx);

// ---- small bits ----
export function Pill({ kind = '', live, children }) { return <span className={`pill ${kind}${live ? ' live' : ''}`}>{live && <i className="dot" />}{children}</span>; }
export function Label({ value }) { if (!value) return null; return <span className={'lbl ' + String(value).toLowerCase()}>{value}</span>; }
export function Stat({ n, label }) { return <div className="stat"><b>{n ?? 0}</b><span>{label}</span></div>; }
export function Empty({ title, children }) { return <div className="empty"><b>{title}</b>{children}</div>; }
export function Spinner() { return <i className="spin" />; }

// localStorage-backed state
export function useStored(key, initial) {
  const [v, setV] = useState(() => { try { const s = localStorage.getItem(key); return s == null ? initial : JSON.parse(s); } catch { return initial; } });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }, [key, v]);
  return [v, setV];
}
export function useInterval(fn, ms, on = true) {
  const ref = useRef(fn); ref.current = fn;
  useEffect(() => { if (!on) return; const t = setInterval(() => ref.current(), ms); return () => clearInterval(t); }, [ms, on]);
}
export function statusKind(s) { return s === 'done' ? 'ok' : s === 'failed' || s === 'stopped' ? 'bad' : s === 'queued' ? 'warn' : 'info'; }
export function statusText(j) { if (!j) return 'no run yet'; if (j.status === 'queued') return `queued · ${j.ahead} ahead`; if (j.status === 'running') return 'finding people'; if (j.status === 'automating') return 'checking activity'; return j.status; }
export const busy = (j) => !!j && ['running', 'queued', 'automating'].includes(j.status) || !!(j && j.activity && ['running', 'filling'].includes(j.activity.status));
