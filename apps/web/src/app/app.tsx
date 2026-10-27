import { useState, useEffect, useRef } from 'react';
import { Drawnix, DrawnixToolState } from '@drawnix/drawnix';
import { PlaitElement, PlaitTheme, Viewport } from '@plait/core';
import localforage from 'localforage';

type AppValue = {
  children: PlaitElement[];
  viewport?: Viewport;
  theme?: PlaitTheme;
};

type Language = 'zh' | 'en' | 'ru' | 'ar' | 'vi';
type MainBoardPreference = {
  language: Language;
  copyTransparent: boolean;
  exportTransparent: boolean;
};
type CloudDocument = {
  id: string;
  title: string;
  revision: number;
  updated_at: string;
};
type CloudDocumentPayload = AppValue & { id?: string; title?: string; revision?: number };

const MAIN_BOARD_CONTENT_KEY = 'main_board_content';
const MAIN_BOARD_TOOL_STATE_KEY = 'main_board_tool_state';
const MAIN_BOARD_PREFERENCE_KEY = 'main_board_preference';
const CLOUD_DOCUMENT_ID_KEY = 'drawnix_cloud_document_id';
const CLOUD_DOCUMENT_REVISION_KEY = 'drawnix_cloud_document_revision';

localforage.config({
  name: 'Drawnix',
  storeName: 'drawnix_store',
  driver: [localforage.INDEXEDDB, localforage.LOCALSTORAGE],
});

async function cloudRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  if (!response.ok) {
    let code = 'HTTP_' + response.status;
    try {
      const body = await response.json() as { error?: string };
      if (body.error) code = body.error;
    } catch { /* keep HTTP status */ }
    throw new Error(code);
  }
  if (!(response.headers.get('content-type') || '').includes('application/json')) {
    throw new Error('ACCESS_LOGIN_REQUIRED');
  }
  return response.json() as Promise<T>;
}

function CloudSyncPanel({
  value,
  onRestore,
}: {
  value: AppValue;
  onRestore: (next: AppValue) => void;
}) {
  const [documents, setDocuments] = useState<CloudDocument[]>([]);
  const [selectedId, setSelectedId] = useState(() => localStorage.getItem(CLOUD_DOCUMENT_ID_KEY) || '');
  const [revision, setRevision] = useState(() => Number(localStorage.getItem(CLOUD_DOCUMENT_REVISION_KEY) || 0));
  const [status, setStatus] = useState('尚未检查登录状态');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [syncEnabled, setSyncEnabled] = useState(false);
  const lastSavedValue = useRef('');

  const refreshDocuments = async () => {
    setBusy(true);
    try {
      const result = await cloudRequest<{ documents: CloudDocument[] }>('/api/documents');
      setDocuments(result.documents || []);
      setStatus('云端已连接');
    } catch (error) {
      const message = error instanceof Error ? error.message : '连接失败';
      setStatus(message === 'UNAUTHORIZED' || message === 'HTTP_401' || message === 'ACCESS_LOGIN_REQUIRED'
        ? '需要先通过 Cloudflare Access 登录'
        : '云端不可用：' + message);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void refreshDocuments(); }, []);

  useEffect(() => {
    if (!syncEnabled || !selectedId || !revision) return;
    const serialized = JSON.stringify(value);
    if (serialized === lastSavedValue.current) return;
    const timer = window.setTimeout(async () => {
      setStatus('正在保存到云端…');
      try {
        const result = await cloudRequest<{ revision: number; updated_at: string }>(
          '/api/documents/' + encodeURIComponent(selectedId),
          { method: 'PUT', body: JSON.stringify({ title: '我的画板', content: value, revision }) },
        );
        setRevision(result.revision);
        localStorage.setItem(CLOUD_DOCUMENT_REVISION_KEY, String(result.revision));
        lastSavedValue.current = serialized;
        setStatus('已保存到云端 · ' + new Date(result.updated_at).toLocaleTimeString());
      } catch (error) {
        const message = error instanceof Error ? error.message : '保存失败';
        setStatus(message === 'REVISION_CONFLICT'
          ? '检测到云端版本冲突，请刷新并重新选择画板，未覆盖云端数据'
          : '云端保存失败，当前内容仍保存在本机：' + message);
      }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [value, selectedId, revision, syncEnabled]);

  const createCloudCopy = async () => {
    setBusy(true);
    try {
      const result = await cloudRequest<{ id: string; revision: number; updated_at: string }>(
        '/api/documents',
        { method: 'POST', body: JSON.stringify({ title: '我的画板', content: value }) },
      );
      setSelectedId(result.id);
      setRevision(result.revision);
      setSyncEnabled(true);
      localStorage.setItem(CLOUD_DOCUMENT_ID_KEY, result.id);
      localStorage.setItem(CLOUD_DOCUMENT_REVISION_KEY, String(result.revision));
      lastSavedValue.current = JSON.stringify(value);
      setStatus('已创建云端副本，后续编辑将自动保存');
      await refreshDocuments();
    } catch (error) {
      setStatus('创建云端副本失败，本机内容未受影响：' + (error instanceof Error ? error.message : '未知错误'));
    } finally {
      setBusy(false);
    }
  };

  const restoreDocument = async (doc: CloudDocument) => {
    if (!window.confirm('从云端恢复“' + doc.title + '”？如果本机画板有未保存内容，恢复会替换当前画板。')) return;
    setBusy(true);
    try {
      const result = await cloudRequest<CloudDocumentPayload>('/api/documents/' + encodeURIComponent(doc.id));
      const restored: AppValue = { children: result.children || [], viewport: result.viewport, theme: result.theme };
      onRestore(restored);
      setSelectedId(doc.id);
      setRevision(doc.revision);
      setSyncEnabled(true);
      localStorage.setItem(CLOUD_DOCUMENT_ID_KEY, doc.id);
      localStorage.setItem(CLOUD_DOCUMENT_REVISION_KEY, String(doc.revision));
      lastSavedValue.current = JSON.stringify(restored);
      setStatus('已恢复云端画板，后续编辑将自动保存');
    } catch (error) {
      setStatus('恢复失败，本机内容未受影响：' + (error instanceof Error ? error.message : '未知错误'));
    } finally {
      setBusy(false);
    }
  };

  const stopCloudSync = () => {
    setSyncEnabled(false);
    setSelectedId('');
    setRevision(0);
    localStorage.removeItem(CLOUD_DOCUMENT_ID_KEY);
    localStorage.removeItem(CLOUD_DOCUMENT_REVISION_KEY);
    lastSavedValue.current = '';
    setStatus('已暂停云端自动保存，本机保存仍正常');
  };

  return (
    <section style={{ position: 'fixed', zIndex: 10000, right: 16, top: 16, width: expanded ? 320 : 'auto', maxWidth: 'calc(100vw - 32px)', background: '#fff', color: '#222', border: '1px solid #ddd', borderRadius: 10, boxShadow: '0 4px 18px #0002', fontSize: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 10 }}>
        <strong style={{ flex: 1 }}>云端自动保存</strong>
        <button type="button" onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '管理'}</button>
      </div>
      {expanded && <div style={{ padding: '0 10px 10px' }}>
        <div style={{ marginBottom: 8, lineHeight: 1.5, overflowWrap: 'anywhere' }}>{status}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <button type="button" disabled={busy} onClick={() => void refreshDocuments()}>刷新云端列表</button>
          <button type="button" disabled={busy} onClick={() => void createCloudCopy()}>将当前画板存为云端副本</button>
          {selectedId && <button type="button" onClick={stopCloudSync}>暂停自动保存</button>}
        </div>
        {documents.length > 0 && <>
          <div style={{ fontWeight: 600, margin: '8px 0' }}>云端画板（恢复前会再次确认）</div>
          <div style={{ maxHeight: 180, overflowY: 'auto' }}>
            {documents.map((doc) => <div key={doc.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderTop: '1px solid #eee' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.title}</div>
                <small>版本 {doc.revision} · {new Date(doc.updated_at).toLocaleString()}</small>
              </div>
              <button type="button" disabled={busy} onClick={() => void restoreDocument(doc)}>恢复</button>
            </div>)}
          </div>
        </>}
        <small style={{ display: 'block', marginTop: 8, color: '#666' }}>本机仍会即时保存。云端冲突时不会自动覆盖另一版本；首次使用前请先登录。</small>
      </div>}
    </section>
  );
}

export function App() {
  const [value, setValue] = useState<AppValue>({ children: [] });
  const [initialToolState, setInitialToolState] = useState<Partial<DrawnixToolState>>();
  const [preference, setPreference] = useState<MainBoardPreference>({
    language: 'zh',
    copyTransparent: false,
    exportTransparent: false,
  });
  const [loaded, setLoaded] = useState(false);
  const [tutorial, setTutorial] = useState(false);

  const updatePreference = (partialPreference: Partial<MainBoardPreference>) => {
    setPreference((currentPreference) => {
      const nextPreference = { ...currentPreference, ...partialPreference };
      void localforage.setItem(MAIN_BOARD_PREFERENCE_KEY, nextPreference);
      return nextPreference;
    });
  };

  useEffect(() => {
    const loadData = async () => {
      const [storedData, storedToolState, storedPreference] = await Promise.all([
        localforage.getItem(MAIN_BOARD_CONTENT_KEY),
        localforage.getItem(MAIN_BOARD_TOOL_STATE_KEY),
        localforage.getItem(MAIN_BOARD_PREFERENCE_KEY),
      ]);
      if (storedData) {
        const appValue = storedData as AppValue;
        setValue(appValue);
        if (appValue.children && appValue.children.length === 0) setTutorial(true);
      } else {
        setTutorial(true);
      }
      if (storedToolState) setInitialToolState(storedToolState as Partial<DrawnixToolState>);
      if (storedPreference) setPreference(storedPreference as MainBoardPreference);
      setLoaded(true);
    };
    void loadData();
  }, []);

  if (!loaded) return null;

  return (
    <>
      <CloudSyncPanel value={value} onRestore={(next) => {
        void localforage.setItem(MAIN_BOARD_CONTENT_KEY, next);
        setValue(next);
        setTutorial(!next.children || next.children.length === 0);
      }} />
      <Drawnix
        value={value.children}
        viewport={value.viewport}
        theme={value.theme}
        initialToolState={initialToolState}
        initialLanguage={preference.language}
        initialPreference={{
          copyTransparent: preference.copyTransparent,
          exportTransparent: preference.exportTransparent,
        }}
        onLanguageChange={(language) => updatePreference({ language })}
        onPreferenceChange={({ copyTransparent, exportTransparent }) => {
          updatePreference({ copyTransparent, exportTransparent });
        }}
        onChange={(nextValue) => {
          const newValue = nextValue as AppValue;
          void localforage.setItem(MAIN_BOARD_CONTENT_KEY, newValue);
          setValue(newValue);
          if (newValue.children && newValue.children.length > 0) setTutorial(false);
        }}
        onToolStateChange={(toolState) => {
          void localforage.setItem(MAIN_BOARD_TOOL_STATE_KEY, toolState);
        }}
        tutorial={tutorial}
        afterInit={() => {
          console.log('board initialized');
        }}
      />
    </>
  );
}

export default App;
