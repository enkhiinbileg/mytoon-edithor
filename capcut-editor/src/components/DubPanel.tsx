import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from '../Icons';
import FastRecapPanel from './FastRecapPanel';
import VoiceEditPanel from './VoiceEditPanel';
import { useEditor } from '../store';
import { importPaths } from '../importMedia';
import { formatTime } from '../util';
import type { AppSettings, DubSegment, TranslateProvider, Voice, VoiceProvider } from '../types';

/**
 * Auto-dub: transcribe -> translate -> speak -> lay the result on the timeline.
 *
 * Each stage leaves its output in `segments`, so the run can be stopped and
 * resumed at any step — the translation is editable before any TTS credits are
 * spent, which is the expensive and irreversible part.
 */

type Stage = 'idle' | 'transcribe' | 'translate' | 'speak' | 'place' | 'fast';

/** Inline progress, shown next to the button that started the work. */
function ProgressBar({ label, pct }: { label: string; pct: number | null }) {
  return (
    <div className="dub-progress">
      <div className="dub-progress-row">
        <span>{label}</span>
        {pct !== null && <span>{pct}%</span>}
      </div>
      <div className="dub-progress-track">
        <i className={pct === null ? 'indeterminate' : ''} style={pct === null ? undefined : { width: `${pct}%` }} />
      </div>
    </div>
  );
}

const LANGUAGES = [
  { id: 'Mongolian', label: 'Монгол' },
  { id: 'English', label: 'English' },
  { id: 'Russian', label: 'Русский' },
  { id: 'Japanese', label: '日本語' },
  { id: 'Korean', label: '한국어' },
  { id: 'Chinese', label: '中文' }
];

/**
 * Catch the two mistakes that otherwise only surface as an API error: pasting
 * a key into the wrong field, and pasting ElevenLabs' key *ID* (what the
 * dashboard lists) instead of the key itself (shown once, at creation).
 */
function keyHint(field: string, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (field === 'anthropicApiKey') {
    if (v.startsWith('sk_')) return 'That looks like an ElevenLabs key — wrong field.';
    if (!v.startsWith('sk-ant-')) return 'Anthropic keys start with sk-ant-.';
  }
  if (field === 'elevenLabsApiKey') {
    if (v.startsWith('sk-ant-')) return 'That looks like an Anthropic key — wrong field.';
    if (!v.startsWith('sk_')) {
      return 'ElevenLabs keys start with sk_. The value listed on the dashboard is the key ID; the key itself is shown only when you create or rotate it.';
    }
  }
  if (field === 'openaiApiKey' && !v.startsWith('sk-')) return 'OpenAI keys start with sk-.';
  return null;
}

const SOURCE_LANGS = [
  { id: 'auto', label: 'Detect' },
  { id: 'en', label: 'English' },
  { id: 'ru', label: 'Russian' },
  { id: 'ja', label: 'Japanese' },
  { id: 'ko', label: 'Korean' },
  { id: 'zh', label: 'Chinese' },
  { id: 'mn', label: 'Mongolian' }
];

export default function DubPanel() {
  const media = useEditor((s) => s.media);
  const clips = useEditor((s) => s.clips);

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  // Keyed by settings field so any provider's key uses the same plumbing.
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});

  const [trProviders, setTrProviders] = useState<TranslateProvider[]>([]);
  const [trProviderId, setTrProviderId] = useState('gemini');
  const [trModels, setTrModels] = useState<string[]>([]);
  const [trModel, setTrModel] = useState('');

  const [whisper, setWhisper] = useState<Awaited<ReturnType<typeof window.api.whisperStatus>> | null>(null);
  const [whisperModel, setWhisperModel] = useState('base');
  const [downloadPct, setDownloadPct] = useState<number | null>(null);

  const [sourceMediaId, setSourceMediaId] = useState('');
  const [sourceLang, setSourceLang] = useState('auto');
  const [targetLang, setTargetLang] = useState('Mongolian');

  const [segments, setSegments] = useState<DubSegment[]>([]);
  const [stage, setStage] = useState<Stage>('idle');
  const [progress, setProgress] = useState<{ label: string; pct: number | null } | null>(null);
  // Wall-clock start of the running stage, used to project a finish time.
  const startedAt = useRef(0);
  // Read inside the autosave timer, which must not re-arm on every selection.
  const sourceMediaRef = useRef<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  // Work on a slice of a long transcript: translate and voice a few minutes
  // first, check the result, then widen the range.
  const [fromMin, setFromMin] = useState('');
  const [toMin, setToMin] = useState('');
  // How far a line may be sped up to fit its slot before it stops sounding human.
  const [maxTempo, setMaxTempo] = useState(1.35);
  const [restoredAt, setRestoredAt] = useState<string | null>(null);

  const [providers, setProviders] = useState<VoiceProvider[]>([]);
  const [providerId, setProviderId] = useState('elevenlabs');
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voiceId, setVoiceId] = useState('TX3LPaxmHKxFdv7VOQHJ');
  // Listing voices needs a separate permission from speaking them, so a
  // minimal-permission key must still be able to dub via a pasted voice ID.
  const [manualVoice, setManualVoice] = useState(false);
  const [voiceListError, setVoiceListError] = useState<string | null>(null);
  const [ttsModels, setTtsModels] = useState<VoiceProvider['models']>([]);
  const [ttsModel, setTtsModel] = useState('');
  const [quota, setQuota] = useState<{ tier: string; used: number; limit: number } | null>(null);

  /* ------------------------------ bootstrap ------------------------------ */

  useEffect(() => {
    window.api.readSettings().then(setSettings);
    window.api.whisperStatus().then(setWhisper);
    window.api.voiceProviders().then((p) => {
      setProviders(p);
      if (p.length && !p.some((x) => x.id === providerId)) setProviderId(p[0].id);
    });
    window.api.translateProviders().then((p) => {
      setTrProviders(p);
      if (p.length && !p.some((x) => x.id === trProviderId)) setTrProviderId(p[0].id);
    });
  }, []);

  const trProvider = trProviders.find((p) => p.id === trProviderId);

  // Ollama reports what is installed locally; the rest fall back to suggestions.
  useEffect(() => {
    if (!trProvider) return;
    let cancelled = false;
    window.api.translateModels(trProviderId).then((res) => {
      if (cancelled) return;
      const list = res.ok && res.models.length ? res.models : trProvider.suggestedModels;
      setTrModels(list);
      setTrModel((cur) => (list.includes(cur) ? cur : list.includes(trProvider.defaultModel) ? trProvider.defaultModel : list[0] || ''));
    });
    return () => { cancelled = true; };
  }, [trProviderId, trProvider]);

  const trKeyReady = !trProvider?.needsKey || Boolean(settings?.[trProvider.keyField ?? '']);

  useEffect(() => window.api.onWhisperProgress((p) => setDownloadPct(p.pct)), []);

  // Pick up where the last session left off. Transcribing and translating are
  // slow and paid; losing them to a restart is not acceptable.
  useEffect(() => {
    window.api.restoreDub().then((s) => {
      if (!s?.segments?.length) return;
      setSegments(s.segments);
      if (s.language) setTargetLang(s.language);
      setRestoredAt(s.savedAt ?? null);
    });
  }, []);

  // Checkpoint after edits settle, so hand-corrected lines are not lost either.
  useEffect(() => {
    if (!segments.length) return;
    const id = setTimeout(() => {
      window.api.autosaveDub({
        segments,
        language: targetLang,
        sourcePath: sourceMediaRef.current
      });
    }, 800);
    return () => clearTimeout(id);
  }, [segments, targetLang]);
  /** Project the remaining time from how long the finished units took. */
  const eta = (done: number, total: number) => {
    if (!startedAt.current || done < 1 || done >= total) return '';
    const perUnit = (Date.now() - startedAt.current) / done;
    const left = Math.round((perUnit * (total - done)) / 1000);
    if (left < 60) return ` · ~${left}s left`;
    return ` · ~${Math.round(left / 60)} min left`;
  };

  useEffect(
    () =>
      window.api.onDubProgress((p) => {
        if (p.stage === 'translate') {
          const batch = p.batch as number;
          const batches = p.batches as number;
          setProgress({
            label: p.waiting
              ? `Batch ${batch}/${batches} · rate limited, waiting ${p.waiting}s`
              : `Batch ${batch}/${batches}${eta(batch, batches)}`,
            pct: batches ? Math.round((batch / batches) * 100) : null
          });
        } else if (p.stage === 'speak') {
          const done = p.done as number;
          const total = p.total as number;
          setProgress({
            label: `Line ${done}/${total}${eta(done, total)}`,
            pct: total ? Math.round((done / total) * 100) : null
          });
        } else if (p.stage === 'transcribe' && typeof p.seconds === 'number') {
          setProgress({ label: `Heard ${formatTime(p.seconds as number, false)}`, pct: null });
        }
      }),
    []
  );

  const provider = providers.find((p) => p.id === providerId);
  const keyReady = provider ? Boolean(settings?.[provider.keyField]) : false;

  // Voices and models come from the account, so a newly released model shows up
  // without a code change. The provider's static list is the offline fallback.
  const loadVoices = useCallback(async () => {
    const fallback = provider?.models ?? [];
    if (!keyReady) {
      setTtsModels(fallback);
      return;
    }

    const res = await window.api.listVoices(providerId);
    if (res.ok) {
      setVoices(res.voices);
      setVoiceListError(null);
      setManualVoice(false);
      setVoiceId((cur) => cur || (res.voices.some((v) => v.id === 'TX3LPaxmHKxFdv7VOQHJ') ? 'TX3LPaxmHKxFdv7VOQHJ' : res.voices[0]?.id || 'TX3LPaxmHKxFdv7VOQHJ'));
    } else {
      // Not fatal: fall back to entering the voice ID by hand.
      setVoices([]);
      setVoiceListError(res.error);
      setManualVoice(true);
    }

    const models = await window.api.listTtsModels(providerId);
    setTtsModels(models.ok && models.models.length ? models.models : fallback);

    const q = await window.api.voiceQuota(providerId);
    setQuota(q.quota);
  }, [providerId, keyReady, provider]);

  useEffect(() => { loadVoices(); }, [loadVoices]);

  // Keep the selection valid whenever the list changes.
  useEffect(() => {
    if (!ttsModels.length) return;
    if (!ttsModels.some((m) => m.id === ttsModel)) setTtsModel(ttsModels[0].id);
  }, [ttsModels, ttsModel]);

  // Default the source to the first video already on the timeline.
  useEffect(() => {
    if (sourceMediaId) return;
    const first = clips.find((c) => c.kind === 'av' && c.mediaId && !c.mediaId.startsWith('freeze-'));
    const m = first ? media.find((x) => x.id === first.mediaId) : media.find((x) => x.kind === 'video' && !x.isInternal);
    if (m) setSourceMediaId(m.id);
  }, [clips, media, sourceMediaId]);

  const sourceMedia = media.find((m) => m.id === sourceMediaId);
  sourceMediaRef.current = sourceMedia?.path;

  /* -------------------------------- actions ------------------------------ */

  async function saveKeys() {
    const patch: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(keyDraft)) {
      if (value.trim()) patch[field] = value.trim();
    }
    if (!Object.keys(patch).length) return;
    setSettings(await window.api.updateSettings(patch));
    setKeyDraft({});
    loadVoices();
  }

  /** The key fields worth showing: whichever providers are actually selected. */
  const keyFields = [
    trProvider?.needsKey && trProvider.keyField
      ? { field: trProvider.keyField, label: trProvider.label }
      : null,
    provider?.keyField ? { field: provider.keyField, label: provider.label } : null
  ].filter(Boolean) as { field: string; label: string }[];

  async function downloadModel(id: string) {
    setDownloadPct(0);
    setError(null);
    try {
      await window.api.downloadWhisperModel(id);
      setWhisper(await window.api.whisperStatus());
    } catch (err) {
      setError(String(err));
    } finally {
      setDownloadPct(null);
    }
  }

  async function runTranscribe() {
    if (!sourceMedia) return;
    setStage('transcribe');
    setError(null);
    setProgress({ label: 'Extracting audio…', pct: null });
    const res = await window.api.transcribe({
      mediaPath: sourceMedia.path,
      model: whisperModel,
      language: sourceLang
    });
    setStage('idle');
    setProgress(null);
    if (res.ok) setSegments(res.segments);
    else setError(res.error);
  }

  async function loadSubtitles() {
    setError(null);
    const res = await window.api.openSubtitles();
    if (res.ok) setSegments(res.segments);
    else if (!res.canceled && res.error) setError(res.error);
  }

  async function runTranslate() {
    if (!inRange.length) return;
    setStage('translate');
    setError(null);
    startedAt.current = Date.now();
    setProgress({ label: 'Starting…', pct: 0 });

    const res = await window.api.translateSegments({
      segments: inRange,
      language: targetLang,
      providerId: trProviderId,
      model: trModel
    });

    setStage('idle');
    setProgress(null);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    // Merge back by id so segments outside the range keep whatever they had.
    const byId = new Map(res.segments.map((s) => [s.id, s.translated ?? '']));
    setSegments((all) =>
      all.map((s) => (byId.has(s.id) ? { ...s, translated: byId.get(s.id) } : s))
    );
  }

  async function runSynthesize() {
    if (!voiceId) { setError('Pick a voice first.'); return; }
    setStage('speak');
    setError(null);
    startedAt.current = Date.now();
    setProgress({ label: 'Starting…', pct: 0 });
    const res = await window.api.synthesizeDub({
      segments: translated,
      options: { providerId, voiceId, modelId: ttsModel, maxTempo }
    });
    if (!res.ok) {
      setStage('idle');
      setProgress(null);
      setError(res.error);
      return;
    }

    // Register each line as media, then lay it on a dedicated track so the
    // original audio stays untouched and can be muted or kept underneath.
    setStage('place');
    setProgress({ label: 'Placing on timeline…', pct: null });
    const items = await importPaths(res.clips.map((c) => c.file));
    const track = useEditor.getState().createTrack('audio', `Dub · ${targetLang}`);

    res.clips.forEach((clip, i) => {
      const item = items[i];
      if (!item) return;
      useEditor.getState().addClip({
        kind: 'av',
        mediaId: item.id,
        trackId: track.id,
        start: clip.start,
        inPoint: 0,
        outPoint: item.duration || clip.duration,
        filterId: 'none',
        effectId: 'none',
        transitionId: 'none',
        transitionDuration: 0.6,
        volume: 1,
        opacity: 1
      });
    });

    setStage('idle');
    setProgress({ label: `Placed ${res.clips.length} lines on the timeline`, pct: 100 });
  }

  /* --------------------------------- derived ----------------------------- */

  const fromSec = fromMin.trim() ? Math.max(0, Number(fromMin) * 60) : 0;
  const toSec = toMin.trim() ? Number(toMin) * 60 : Infinity;
  const rangeValid = !Number.isNaN(fromSec) && !Number.isNaN(toSec) && toSec > fromSec;

  const inRange = useMemo(
    () => (rangeValid ? segments.filter((s) => s.start >= fromSec && s.start < toSec) : segments),
    [segments, fromSec, toSec, rangeValid]
  );

  // Rendering thousands of textareas locks the UI, so only a window is drawn.
  const MAX_ROWS = 150;
  const shownRows = inRange.slice(0, MAX_ROWS);

  const translated = inRange.filter((s) => (s.translated || '').trim());
  const characters = translated.reduce((n, s) => n + (s.translated || '').length, 0);
  const creditsPerChar = ttsModels.find((m) => m.id === ttsModel)?.credits ?? 1;
  const credits = Math.round(characters * creditsPerChar);
  const busy = stage !== 'idle';

  const overLimit = useMemo(
    () => (quota ? quota.used + credits > quota.limit : false),
    [quota, credits]
  );

  return (
    <section className="panel">
      <div className="panel-head">
        <span className="panel-title">Auto dub</span>
      </div>

      <div className="panel-body">
        <VoiceEditPanel initialSource={sourceMedia?.path} translation={{providerId:trProviderId,model:trModel}}
          providers={trProviders} models={trModels} onProvider={setTrProviderId} onModel={setTrModel}
          whisperModel={whisperModel} sourceLanguage={sourceLang} disabled={busy && stage!=='fast'}
          onBusy={value=>setStage(value?'fast':'idle')} onKeys={()=>{setShowKeys(true);setTimeout(()=>document.querySelector('.dub-step-head')?.scrollIntoView({behavior:'smooth'}),0);}} />
        <details><summary style={{padding:'10px 0',fontSize:12}}>Нэмэлт: шинэ voice үүсгэх хуучин горим</summary>
        <FastRecapPanel
          spec={{source:sourceMedia?.path,segments,sourceLanguage:sourceLang,whisperModel,language:targetLang,
            translation:{providerId:trProviderId,model:trModel},voice:{providerId,voiceId,modelId:ttsModel,maxTempo}}}
          ready={Boolean(keyReady && trKeyReady && voiceId && ttsModel && trModel)}
          disabled={busy && stage !== 'fast'} onBusy={value=>setStage(value?'fast':'idle')}
          onImport={async file=>{const added=await importPaths([file]);if(added[0])setSourceMediaId(added[0].id);}}
        />
        </details>
        {/* ------------------------------ keys ----------------------------- */}
        <button className="dub-step-head" onClick={() => setShowKeys((v) => !v)}>
          <span>API keys</span>
          <span className={'dot' + (settings?.anthropicApiKey && settings?.elevenLabsApiKey ? ' ok' : '')} />
        </button>
        {showKeys && (
          <div className="dub-step">
            {keyFields.length === 0 && (
              <div className="empty-hint" style={{ textAlign: 'left' }}>
                The selected providers need no keys.
              </div>
            )}
            {keyFields.map(({ field, label }) => {
              const draft = keyDraft[field] ?? '';
              const hint = keyHint(field, draft);
              return (
                <div key={field}>
                  <label className="dub-label">{label} {settings?.[field] ? '· saved' : ''}</label>
                  <input
                    className="insp-input" type="password" placeholder="Paste key"
                    value={draft}
                    onChange={(e) => setKeyDraft((d) => ({ ...d, [field]: e.target.value }))}
                  />
                  {hint && <div className="dub-warn">{hint}</div>}
                </div>
              );
            })}

            {keyFields.length > 0 && (
              <button className="btn" style={{ marginTop: 8 }} onClick={saveKeys}>Save keys</button>
            )}
            <div className="empty-hint" style={{ textAlign: 'left', padding: '8px 0 0' }}>
              Stored encrypted on this machine and never shown again.
            </div>
          </div>
        )}

        {/* --------------------------- 1. transcript ------------------------ */}
        <div className="dub-step-head static"><span>1 · Transcript</span></div>
        <div className="dub-step">
          <label className="dub-label">Video</label>
          <select className="insp-select wide" value={sourceMediaId} onChange={(e) => setSourceMediaId(e.target.value)}>
            <option value="">Select media…</option>
            {media.filter((m) => m.kind !== 'image').map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>

          {whisper?.available ? (
            <>
              <label className="dub-label">Whisper model</label>
              <select className="insp-select wide" value={whisperModel} onChange={(e) => setWhisperModel(e.target.value)}>
                {whisper.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} · {m.mb} MB {m.installed ? '· ready' : ''}
                  </option>
                ))}
              </select>

              {!whisper.models.find((m) => m.id === whisperModel)?.installed && (
                <button className="btn" style={{ marginTop: 8 }} disabled={downloadPct !== null}
                  onClick={() => downloadModel(whisperModel)}>
                  {downloadPct !== null ? `Downloading ${downloadPct}%` : 'Download model'}
                </button>
              )}

              <label className="dub-label">Spoken language</label>
              <select className="insp-select wide" value={sourceLang} onChange={(e) => setSourceLang(e.target.value)}>
                {SOURCE_LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>

              <button
                className="btn primary" style={{ marginTop: 10, width: '100%' }}
                disabled={busy || !sourceMedia || !whisper.models.find((m) => m.id === whisperModel)?.installed}
                onClick={runTranscribe}
              >
                {stage === 'transcribe' ? 'Transcribing…' : 'Transcribe'}
              </button>
              {stage === 'transcribe' && progress && <ProgressBar {...progress} />}
            </>
          ) : (
            <div className="empty-hint" style={{ textAlign: 'left' }}>
              whisper-cli not found. Install Shotcut (it bundles it) or import subtitles instead.
            </div>
          )}

          <div className="dub-filerow" style={{ marginTop: 8 }}>
            <button className="btn" onClick={loadSubtitles} disabled={busy}>
              Import SRT / VTT
            </button>
            <button
              className="btn"
              disabled={busy}
              onClick={async () => {
                const res = await window.api.openDubFrom();
                if (res.ok) {
                  setSegments(res.data.segments);
                  if (res.data.language) setTargetLang(res.data.language);
                  setRestoredAt(null);
                } else if (!res.canceled && res.error) setError(res.error);
              }}
            >
              Open saved
            </button>
          </div>

          {restoredAt && (
            <div className="empty-hint" style={{ textAlign: 'left', padding: '8px 0 0' }}>
              Restored {segments.length.toLocaleString()} lines from your last session.
            </div>
          )}
        </div>

        {/* --------------------------- 2. translation ----------------------- */}
        <div className="dub-step-head static">
          <span>2 · Translation</span>
          {segments.length > 0 && <span className="dub-count">{segments.length}</span>}
        </div>
        <div className="dub-step">
          <label className="dub-label">Range (minutes)</label>
          <div className="dub-range">
            <input
              className="insp-input" inputMode="decimal" placeholder="from"
              value={fromMin} onChange={(e) => setFromMin(e.target.value)}
            />
            <span>→</span>
            <input
              className="insp-input" inputMode="decimal" placeholder="end"
              value={toMin} onChange={(e) => setToMin(e.target.value)}
            />
          </div>
          <div className="insp-row">
            <span>In range</span>
            <span>{inRange.length.toLocaleString()} / {segments.length.toLocaleString()}</span>
          </div>
          {!rangeValid && <div className="dub-warn">The end must be later than the start.</div>}

          <label className="dub-label">Target language</label>
          <select className="insp-select wide" value={targetLang} onChange={(e) => setTargetLang(e.target.value)}>
            {LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>

          <label className="dub-label">Engine</label>
          <select className="insp-select wide" value={trProviderId} onChange={(e) => setTrProviderId(e.target.value)}>
            {trProviders.map((p) => <option key={p.id} value={p.id}>{p.label} · {p.note}</option>)}
          </select>

          <label className="dub-label">Model</label>
          <input
            className="insp-input"
            list="dub-tr-models"
            placeholder={trProvider?.defaultModel ?? ''}
            value={trModel}
            onChange={(e) => setTrModel(e.target.value.trim())}
          />
          <datalist id="dub-tr-models">
            {trModels.map((m) => <option key={m} value={m} />)}
          </datalist>

          <button
            className="btn primary" style={{ marginTop: 10, width: '100%' }}
            disabled={busy || !inRange.length || !trKeyReady || !rangeValid}
            onClick={runTranslate}
          >
            {stage === 'translate'
              ? 'Translating…'
              : `Translate ${inRange.length.toLocaleString()} lines with ${trProvider?.label ?? '…'}`}
          </button>

          {stage === 'translate' && progress && <ProgressBar {...progress} />}

          {!trKeyReady && (
            <div className="empty-hint" style={{ textAlign: 'left', padding: '6px 0 0' }}>
              Add the {trProvider?.label} key in the API keys section above.
            </div>
          )}

          {segments.length > 0 && (
            <div className="dub-filerow">
              <button
                className="btn"
                onClick={async () => {
                  const res = await window.api.saveDubAs({ segments, language: targetLang });
                  if (!res.ok && res.error) setError(res.error);
                }}
              >
                Save
              </button>
              <button
                className="btn"
                onClick={async () => {
                  const res = await window.api.exportDubSrt(segments);
                  if (!res.ok && res.error) setError(res.error);
                }}
              >
                Export SRT
              </button>
            </div>
          )}

          {shownRows.length > 0 && (
            <>
              <div className="dub-rows">
                {shownRows.map((s) => (
                  <div key={s.id} className="dub-row">
                    <div className="dub-row-time">{formatTime(s.start, false)}</div>
                    <div className="dub-row-src">{s.text}</div>
                    <textarea
                      className="insp-input"
                      rows={2}
                      placeholder="—"
                      value={s.translated ?? ''}
                      onChange={(e) =>
                        setSegments((all) =>
                          all.map((x) => (x.id === s.id ? { ...x, translated: e.target.value } : x))
                        )
                      }
                    />
                  </div>
                ))}
              </div>
              {inRange.length > shownRows.length && (
                <div className="empty-hint" style={{ textAlign: 'left' }}>
                  Showing the first {shownRows.length} of {inRange.length.toLocaleString()} lines.
                  Narrow the range to review and edit the rest.
                </div>
              )}
            </>
          )}
        </div>

        {/* ------------------------------ 3. voice -------------------------- */}
        <div className="dub-step-head static"><span>3 · Voice</span></div>
        <div className="dub-step">
          {providers.length > 1 && (
            <>
              <label className="dub-label">Provider</label>
              <select className="insp-select wide" value={providerId} onChange={(e) => setProviderId(e.target.value)}>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </>
          )}

          <label className="dub-label">Voice</label>
          {manualVoice ? (
            <input
              className="insp-input"
              placeholder="Paste a voice ID"
              value={voiceId}
              onChange={(e) => setVoiceId(e.target.value.trim())}
            />
          ) : (
            <select className="insp-select wide" value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
              <option value="">{keyReady ? 'Select a voice…' : 'Add an API key first'}</option>
              {voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          )}

          <button
            className="btn ghost"
            style={{ alignSelf: 'flex-start', padding: '4px 0', fontSize: 11, color: 'var(--text-dim)' }}
            onClick={() => (manualVoice ? loadVoices() : setManualVoice(true))}
          >
            {manualVoice ? 'Try loading the voice list' : 'Enter a voice ID instead'}
          </button>

          {voiceListError && (
            <div className="empty-hint" style={{ textAlign: 'left', padding: '2px 0 0' }}>
              The voice list needs the <b>voices_read</b> permission, which speaking does not.
              Paste a voice ID here and dubbing still works.
            </div>
          )}

          <label className="dub-label">Model</label>
          <select className="insp-select wide" value={ttsModel} onChange={(e) => setTtsModel(e.target.value)}>
            {ttsModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}{m.note ? ` · ${m.note}` : ''}
              </option>
            ))}
          </select>
          {!keyReady && (
            <div className="empty-hint" style={{ textAlign: 'left', padding: '6px 0 0' }}>
              Add the API key to load the models your account can actually use.
            </div>
          )}

          <label className="dub-label">Fit to timing · up to {maxTempo.toFixed(2)}× faster</label>
          <input
            className="insp-slider" type="range" min={1} max={1.6} step={0.05}
            value={maxTempo} onChange={(e) => setMaxTempo(Number(e.target.value))}
          />
          <div className="empty-hint" style={{ textAlign: 'left', padding: '2px 0 6px' }}>
            A translated line rarely takes exactly as long to say. Lines are sped up
            to fit their slot, but only this far — past about 1.4× speech stops
            sounding like a person. Lines that still overrun are reported.
          </div>

          <div className="insp-row"><span>Characters</span><span>{characters.toLocaleString()}</span></div>
          <div className="insp-row"><span>Credits</span><span>{credits.toLocaleString()}</span></div>
          {quota && (
            <div className="insp-row">
              <span>Quota left</span>
              <span style={overLimit ? { color: '#e5484d' } : undefined}>
                {(quota.limit - quota.used).toLocaleString()}
              </span>
            </div>
          )}
          {overLimit && (
            <div className="empty-hint" style={{ textAlign: 'left', color: '#e5484d' }}>
              This job needs more credits than the account has left.
            </div>
          )}

          <button
            className="btn primary" style={{ marginTop: 10, width: '100%' }}
            disabled={busy || !translated.length || !voiceId}
            onClick={runSynthesize}
          >
            {stage === 'speak' ? 'Generating voice…'
              : stage === 'place' ? 'Placing…'
              : `Generate & place ${translated.length} lines`}
          </button>

          {(stage === 'speak' || stage === 'place') && progress && <ProgressBar {...progress} />}
        </div>

        {stage === 'idle' && progress && (
          <div className="dub-note"><Icon name="audio" style={{ width: 13, height: 13 }} />{progress.label}</div>
        )}
        {error && <div className="dub-error">{error}</div>}
        {!error && voiceListError && <div className="dub-error subtle">{voiceListError}</div>}
      </div>
    </section>
  );
}
