import {useEffect,useState} from 'react';
import type {DubSegment,TranslateProvider,VoiceEditResult,VoiceEditRow} from '../types';
import {importPaths} from '../importMedia';
import {useEditor} from '../store';

const name=(p:string)=>p.split(/[\\/]/).pop()||'';
const clock=(n:number)=>`${Math.floor(n/60)}:${String(Math.floor(n%60)).padStart(2,'0')}`;
const stages:Record<string,string>={'source-transcript':'Эх видеоны яриаг таньж байна','voice-transcript':'Монгол voice-ийг таньж байна',align:'Ижил үйл явдалтай дүрсүүдийг холбож байна',render:'Дүрсийг voice-ийн хугацаанд эвлүүлж байна'};
export default function VoiceEditPanel({initialSource,translation,providers,models,onProvider,onModel,whisperModel,sourceLanguage,disabled,onBusy,onKeys}: {
  initialSource?:string;translation:{providerId:string;model:string};providers:TranslateProvider[];models:string[];
  onProvider:(id:string)=>void;onModel:(id:string)=>void;whisperModel:string;sourceLanguage:string;
  disabled:boolean;onBusy:(busy:boolean)=>void;onKeys:()=>void;
}) {
  const [source,setSource]=useState(initialSource||'');
  const [voice,setVoice]=useState('');
  const [sourceRows,setSourceRows]=useState<DubSegment[]>();
  const [voiceRows,setVoiceRows]=useState<DubSegment[]>();
  const [promptGuidance,setPromptGuidance]=useState('');
  const [isSilent,setIsSilent]=useState(false);
  const [busy,setBusy]=useState(false);
  const [status,setStatus]=useState<Record<string,unknown>>({});
  const [job,setJob]=useState<VoiceEditResult|null>(null);
  const [plan,setPlan]=useState<VoiceEditRow[]>([]);
  const [error,setError]=useState('');
  const [output,setOutput]=useState<{path?:string;reportPath?:string;projectPath?:string;renderSeconds?:number;encoder?:string}>();
  const [applyToTimeline,setApplyToTimeline]=useState(true);
  const [preview,setPreview]=useState<VoiceEditRow|null>(null);
  useEffect(()=>{
    if(!source&&initialSource) {
      setSource(initialSource);
      window.api.probe(initialSource).then(p=>setIsSilent(!p.hasAudio)).catch(()=>{});
    }
  },[initialSource,source]);
  useEffect(()=>window.api.onVoiceEditProgress(setStatus),[]);
  function reset(){setJob(null);setPlan([]);setOutput(undefined);setError('');}
  async function pick(kind:'video'|'voice') {
    const files=await window.api.openMedia();if(!files[0])return;reset();
    if(kind==='video'){
      setSource(files[0]);
      setSourceRows(undefined);
      window.api.probe(files[0]).then(p=>setIsSilent(!p.hasAudio)).catch(()=>{});
    }else{
      setVoice(files[0]);
      setVoiceRows(undefined);
    }
  }
  async function subtitles(kind:'video'|'voice') {
    const result=await window.api.openSubtitles();
    if(result.ok){reset();if(kind==='video')setSourceRows(result.segments);else setVoiceRows(result.segments);}
    else if(result.error)setError(result.error);
  }
  async function render(id:string,rows:VoiceEditRow[]) {
    setStatus({stage:'render'});
    const result=await window.api.renderVoiceEdit({jobId:id,plan:rows});
    if(result.ok)setOutput(result);else if(result.error)setError(result.error);
  }
  async function start() {
    setBusy(true);onBusy(true);reset();setStatus({stage:'source-transcript'});
    try {
      const result=await window.api.prepareVoiceEdit({
        source,voice,sourceSegments:sourceRows,voiceSegments:voiceRows,
        sourceLanguage,whisperModel,translation,promptGuidance,isSilentVideo:isSilent
      });
      if(!result.ok){setError(result.error||'Холбож чадсангүй.');return;}
      setJob(result);setPlan(result.plan||[]);
      if(result.isSilent)setIsSilent(true);
      if(applyToTimeline&&result.projectPath){
        try {
          const res=await window.api.openProjectPath?.(result.projectPath);
          if(res?.ok&&res.data) useEditor.getState().loadProject(res.data,res.path);
        }catch(e){console.warn('Could not load directly into timeline:',e);}
      }
    }catch(e){setError(String(e));}finally{setBusy(false);onBusy(false);}
  }
  const update=(id:number,patch:Partial<VoiceEditRow>)=>{setOutput(undefined);setPlan(p=>p.map(r=>r.id===id?{...r,...patch}:r));};
  return <div className="fast-recap voice-edit-panel">
    <div style={{
      marginBottom: 12,
      padding: '12px 14px',
      borderRadius: 8,
      background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.2) 0%, rgba(168, 85, 247, 0.2) 100%)',
      border: '1px solid rgba(99, 102, 241, 0.4)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 10
    }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#fff', display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>🎙️</span> AI Скрипт Студи (ElevenLabs v3)
        </div>
        <div style={{ fontSize: 11, color: '#c4b5fd', marginTop: 2 }}>
          Монгол скриптээс шууд хоолой үүсгэж, манхва дүрсэнд 1 товшилтоор тааруулах
        </div>
      </div>
      <button
        className="btn"
        style={{
          background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)',
          color: '#fff',
          fontSize: 11,
          fontWeight: 600,
          padding: '6px 14px',
          borderRadius: 6,
          border: 'none',
          whiteSpace: 'nowrap',
          boxShadow: '0 2px 8px rgba(99, 102, 241, 0.35)',
          cursor: 'pointer'
        }}
        onClick={() => {
          window.dispatchEvent(new CustomEvent('open-script-studio'));
        }}
      >
        Нээх 🚀
      </button>
    </div>
    <div className="fast-recap-title">Бэлэн voice-д дүрс тааруулах</div>
    <p>Gemini-ээр орчуулаад ElevenLabs-аас гаргасан Монгол voice-оо оруулна. Дүрсийг тэр ярианд тааруулж эвлүүлнэ. Voice-ийн хурд, яриаг өөрчлөхгүй.</p>
    <fieldset disabled={busy||disabled}>
      <div className="dub-filerow"><button className="btn" onClick={()=>pick('video')}>1 · Эх видео</button><button className="btn" onClick={()=>pick('voice')}>2 · Монгол voice</button></div>
      <p className="fast-recap-source">Видео: {name(source)||'сонгоогүй'} {isSilent ? '· (Дуугүй дүрс)' : ''}<br/>Voice: {name(voice)||'сонгоогүй'}</p>
      <div style={{marginTop:8,marginBottom:8}}>
        <label className="dub-label">Промпт болон дүрсний зохицох удирдамж</label>
        <textarea
          className="insp-input"
          style={{width:'100%',height:58,resize:'vertical',fontSize:12,padding:'6px 8px',fontFamily:'inherit'}}
          placeholder="Чиглэл өгөх: Дүрс нь тэд дэх секундээс эхэлнэ • 3-6 секундийн динамик сонирхолтой кадрууд сонгох..."
          value={promptGuidance}
          onChange={e=>setPromptGuidance(e.target.value)}
          disabled={busy}
        />
      </div>
      <details><summary>Transcript / хадмал байгаа бол</summary>
        <p>Хугацаатай SRT/VTT оруулбал яриа таних алхмыг алгасна. Эх transcript нь видеотой, Монгол transcript нь бэлэн voice-тойгоо таарсан хугацаатай байх ёстой.</p>
        <div className="dub-filerow"><button className="btn" onClick={()=>subtitles('video')}>Эх SRT/VTT {sourceRows?`(${sourceRows.length})`:''}</button><button className="btn" onClick={()=>subtitles('voice')}>Voice SRT/VTT {voiceRows?`(${voiceRows.length})`:''}</button></div>
      </details>
      <label className="dub-label">Ярианы агуулгаар дүрс холбох үйлчилгээ</label>
      <select className="insp-select wide" value={translation.providerId} onChange={e=>{onProvider(e.target.value);reset();}}>{providers.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select>
      <select className="insp-select wide" aria-label="Picture matching model" value={translation.model} onChange={e=>{onModel(e.target.value);reset();}}>{models.map(m=><option key={m}>{m}</option>)}</select>
      <button className="btn" onClick={onKeys} style={{marginTop:8}}>API түлхүүр тохируулах</button>
      <p>Зөвхөн transcript-уудыг сонгосон үйлчилгээнд илгээнэ. ElevenLabs API хэрэггүй. Холбох үйлчилгээ төлбөртэй байж болно.</p>
      <label className="fast-recap-check"><input type="checkbox" checked={applyToTimeline} onChange={e=>setApplyToTimeline(e.target.checked)}/>Timeline дээр шууд байршуулах (Зөвлөмж: Шалгаж засахад бэлэн болно)</label>
      <button className="btn primary" style={{width:'100%'}} disabled={!source||!voice||!translation.model} onClick={start}>Дүрсийг voice-д тааруулах</button>
      <p>Дүрс нь voice-ийн өгүүлбэр, завсарлагуудад яг тааруулан дэс дарааллаар зүсэгдэж Timeline дээр орно. Экспорт хийхгүй, та хүссэнээрээ засаж, олон voice цуглуулах боломжтой.</p>
    </fieldset>
    {busy&&<div className="fast-recap-status" role="status"><strong>{stages[String(status.stage)]||'Боловсруулж байна…'}</strong>
      {typeof status.done==='number'&&<p>{status.done} / {String(status.total)} хэсэг · {String(status.encoder||'')}</p>}
      <button className="btn" onClick={()=>{void window.api.cancelVoiceEdit();}}>Зогсоох</button></div>}
    {error&&<div className="dub-warn">{error}</div>}
    {!!plan.length&&<div className="fast-recap-status">
      <strong>{plan.length} дүрсний хэсэг · Voice {clock(job?.voiceDuration||0)}</strong>
      <p>{plan.filter(s=>s.review).length} хэсгийг шалгах шаардлагатай. Хугацаа секундээр.</p>
      {preview&&<div>
        <p>Дүрс {clock(preview.sourceStart)}–{clock(preview.sourceEnd)} · Voice {clock(preview.targetStart)}–{clock(preview.targetEnd)}</p>
        <video key={preview.id+'video'} controls muted style={{width:'100%',maxHeight:170}} src={window.api.toMediaUrl(source)}
          onLoadedMetadata={e=>{e.currentTarget.currentTime=preview.sourceStart;}}
          onTimeUpdate={e=>{if(e.currentTarget.currentTime>=preview.sourceEnd)e.currentTarget.pause();}}/>
        <audio key={preview.id+'voice'} controls style={{width:'100%'}} src={window.api.toMediaUrl(voice)}
          onLoadedMetadata={e=>{e.currentTarget.currentTime=preview.targetStart;}}
          onTimeUpdate={e=>{if(e.currentTarget.currentTime>=preview.targetEnd)e.currentTarget.pause();}}/>
      </div>}
      <details open={plan.some(s=>s.review)}><summary>Дүрсний хэсгүүдийг шалгах / засах</summary>
        <div className="voice-edit-rows">{plan.map(row=><div key={row.id} className={'voice-edit-row'+(row.review?' needs-review':'')}>
          <strong>Voice {clock(row.targetStart)}–{clock(row.targetEnd)}</strong><p>{row.text}</p><button className="btn" onClick={()=>setPreview(row)}>Дүрс / voice шалгах</button>
          <div className="fast-recap-grid"><label>Дүрс эхлэх<input className="insp-input" type="number" min="0" step="0.1" disabled={busy} value={row.sourceStart} onChange={e=>update(row.id,{sourceStart:Number(e.target.value),review:true})}/></label>
          <label>Дүрс дуусах<input className="insp-input" type="number" min="0" step="0.1" disabled={busy} value={row.sourceEnd} onChange={e=>update(row.id,{sourceEnd:Number(e.target.value),review:true})}/></label></div>
          <label className="fast-recap-check"><input type="checkbox" disabled={busy} checked={!row.review} onChange={e=>update(row.id,{review:!e.target.checked})}/>Энэ дүрс яриатай таарна</label>
          {(row.sourceEnd-row.sourceStart)/(row.targetEnd-row.targetStart)>2&&<p>Дүрс 2×-оос хурдан тоглогдоно. Богино эх хэсэг сонгож болно.</p>}
        </div>)}</div>
      </details>
      <div className="dub-filerow" style={{marginTop:8}}>
        {job?.projectPath&&<button className="btn" disabled={busy} onClick={async()=>{
          try {
            const res=await window.api.openProjectPath?.(job.projectPath!);
            if(res?.ok&&res.data) useEditor.getState().loadProject(res.data,res.path);
          }catch(e){setError(String(e));}
        }}>Timeline дээр засахаар нээх</button>}
        <button className="btn primary" disabled={busy||plan.some(s=>s.review)} onClick={async()=>{
          if(!job?.jobId)return;setBusy(true);onBusy(true);setError('');
          try{await render(job.jobId,plan);}catch(e){setError(String(e));}finally{setBusy(false);onBusy(false);}
        }}>Энэ эвлүүлгээр экспортлох</button>
      </div>
    </div>}
    {output?.path&&<div className="fast-recap-status"><strong>Voice-д тааруулсан видео бэлэн</strong><p>Render: {Math.round(output.renderSeconds||0)} секунд · {output.encoder}</p>
      <div className="dub-filerow">
        <button className="btn" onClick={()=>window.api.showItemInFolder(output.path!)}>Видео харах</button>
        <button className="btn" onClick={()=>{void importPaths([output.path!]);}}>Media-д нэмэх</button>
        {output.projectPath&&<button className="btn primary" onClick={async()=>{
          try {
            const res=await window.api.openProjectPath?.(output.projectPath!);
            if(res?.ok&&res.data) useEditor.getState().loadProject(res.data,res.path);
          }catch(e){setError(String(e));}
        }}>Timeline дээр нээх</button>}
      </div>
    </div>}
  </div>;
}
