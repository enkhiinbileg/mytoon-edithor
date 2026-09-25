import { useEffect, useState } from 'react';
import type { FastRecapSpec, FastRecapResult } from '../types';
import { importPaths } from '../importMedia';

const labels: Record<string,string> = {
  download:'Видео татаж байна', transcribe:'Яриаг таньж байна', translate:'Орчуулж байна',
  speak:'Монгол дуу үүсгэж байна', shorten:'Урт өгүүлбэрийг богиносгож байна',
  processed:'Хэсэг бэлэн', mix:'Дууг нэгтгэж байна', export:'Видео экспортолж байна'
};
const time = (seconds:number) => `${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;

export default function FastRecapPanel({ spec, ready, disabled, onBusy, onImport }: {
  spec: Omit<FastRecapSpec,'glossary'|'concurrency'|'characterBudget'>;
  ready: boolean; disabled: boolean; onBusy:(value:boolean)=>void; onImport:(path:string)=>Promise<void>;
}) {
  const [url,setUrl] = useState('');
  const [downloader,setDownloader] = useState(false);
  const [setup,setSetup] = useState(false);
  const [running,setRunning] = useState(false);
  const [useTranscript,setUseTranscript] = useState(false);
  const [voiceChecked,setVoiceChecked] = useState(false);
  const [concurrency,setConcurrency] = useState(2);
  const [budget,setBudget] = useState(120000);
  const [glossary,setGlossary] = useState('');
  const [elapsed,setElapsed] = useState(0);
  const [progress,setProgress] = useState<Record<string,unknown>>({});
  const [result,setResult] = useState<FastRecapResult|null>(null);
  useEffect(()=>{ window.api.recapStatus().then(s=>setDownloader(s.downloader)); },[]);
  useEffect(()=>{setVoiceChecked(false);},[spec.voice.providerId,spec.voice.voiceId,spec.voice.modelId]);
  useEffect(()=>window.api.onRecapProgress(p=>{setProgress(p);}),[]);
  useEffect(()=>{
    if (!running) return;
    const start=Date.now();
    const timer=setInterval(()=>setElapsed((Date.now()-start)/1000),500);
    return ()=>clearInterval(timer);
  },[running]);
  async function start() {
    setRunning(true);onBusy(true);setResult(null);setElapsed(0);setProgress({});
    try {
      setResult(await window.api.runFastRecap({...spec,url:url.trim()||undefined,
        segments:useTranscript?spec.segments:undefined,concurrency,characterBudget:budget,glossary}));
    } catch(e) {setResult({ok:false,error:String(e)});}
    finally {setRunning(false);onBusy(false);}
  }
  return <div className="fast-recap">
    <div className="fast-recap-title">Монгол recap · Хурдан горим</div>
    <p>2 цагийн видеог 10 минутад боловсруулах зорилт. Эх дүрсийг хадгалж, Монгол дуугаар солино.</p>
    <fieldset disabled={running||disabled||setup}>
      <label className="dub-label">YouTube холбоос эсвэл доор сонгосон видео</label>
      <input className="insp-input" aria-label="YouTube URL" placeholder="https://www.youtube.com/watch?v=…" value={url} onChange={e=>setUrl(e.target.value)}/>
      <div className="dub-filerow">
        <button className="btn" onClick={async()=>{
          const files=await window.api.openMedia();if(files[0]) {await onImport(files[0]);setUrl('');}
        }}>Видео оруулах</button>
        {!downloader&&<button className="btn" onClick={async()=>{
          setSetup(true);setResult(null);
          try {const r=await window.api.setupRecapDownloader();if(r.ok)setDownloader(true);else setResult(r);}
          catch(e){setResult({ok:false,error:String(e)});}finally{setSetup(false);}
        }}>{setup?'Суулгаж байна…':'YouTube татагч суулгах'}</button>}
      </div>
      <p className="fast-recap-source">{url.trim()?'YouTube → 1080p хүртэл':spec.source?.split(/[\\/]/).pop()||'Эх видео сонгоогүй'}</p>
      <label className="fast-recap-check"><input type="checkbox" checked={useTranscript} disabled={!spec.segments?.length||!!url.trim()} onChange={e=>setUseTranscript(e.target.checked)}/>
        Доорх transcript энэ видеотой таарна — ашиглах ({spec.segments?.length||0} мөр)</label>
      <div className="fast-recap-grid">
        <label className="dub-label">Зэрэг үүсгэх дуу
          <input className="insp-input" type="number" min="1" max="20" value={concurrency} onChange={e=>setConcurrency(Number(e.target.value))}/></label>
        <label className="dub-label">Нэг ажиллуулалтын TTS тэмдэгтийн хязгаар
          <input className="insp-input" type="number" min="1" max="2000000" step="1000" value={budget} onChange={e=>setBudget(Number(e.target.value))}/></label>
      </div>
      <p>Зэрэг хүсэлтийн тоог ElevenLabs багцынхаа хязгаарт тохируулна. Тэмдэгтийн хязгаар нь мөнгөн дүн биш; орчуулгын төлбөр тусдаа.</p>
      <label className="dub-label">Нэр, дуудлагын толь (заавал биш)</label>
      <textarea className="insp-input" rows={2} placeholder="Sung Jinwoo = Сон Жин Ү; …" value={glossary} onChange={e=>setGlossary(e.target.value)}/>
      <label className="fast-recap-check"><input type="checkbox" checked={voiceChecked} onChange={e=>setVoiceChecked(e.target.checked)}/>
        Доор сонгосон хоолой, загварын Монгол дуудлагыг шалгасан</label>
      <p>Доорх орчуулга, хоолойн тохиргоог ашиглана. “Боловсруулах” дарахад тохируулсан API үйлчилгээг ашиглаж, төлбөртэй дуу үүсгэнэ.</p>
      <button className="btn primary" style={{width:'100%'}} disabled={!ready||!voiceChecked||(!url.trim()&&!spec.source)||(!!url.trim()&&!downloader)||!(budget>0)||!(concurrency>=1&&concurrency<=20)} onClick={start}>
        Монгол recap боловсруулах / үргэлжлүүлэх
      </button>
      {!ready&&<p>Доор API түлхүүр, орчуулгын загвар, хоолойгоо тохируулна уу.</p>}
    </fieldset>
    {running&&<div className="fast-recap-status" role="status">
      <strong>{labels[String(progress.stage)]||'Эхлүүлж байна…'} · {time(elapsed)}</strong>
      {typeof progress.chunk==='number'&&<p>Хэсэг {progress.chunk}{progress.totalChunks?` / ${progress.totalChunks}`:''}</p>}
      {typeof progress.done==='number'&&<p>Бэлэн {progress.done} / {String(progress.total||'?')}</p>}
      {typeof progress.reservedCharacters==='number'&&<p>TTS хүсэлтэд {progress.reservedCharacters.toLocaleString()} тэмдэгт</p>}
      {elapsed>600&&<p>10 минутын зорилт хэтэрсэн. Боловсруулалт үргэлжилж байна.</p>}
      <button className="btn" onClick={()=>{void window.api.cancelFastRecap();setProgress({stage:'stopping'});}}>Зогсоох, хийснийг хадгалах</button>
    </div>}
    {result&&!result.canceled&&<div className="fast-recap-status" role="status">
      {result.error?<div className="dub-warn">{result.error}</div>:<>
        <strong>{result.status==='review'?'Шалгах өгүүлбэр байна — экспорт хийгдээгүй':'Монгол видео бэлэн'}</strong>
        {typeof result.totalElapsedSeconds==='number'&&<p>Нийт {time(result.totalElapsedSeconds)} · {result.targetMet?'10 минутын зорилтод багтсан':'10 минутын зорилт биелээгүй'}</p>}
        <p>{result.cached||0} кэш ашигласан · {result.reservedCharacters?.toLocaleString()||0} TTS тэмдэгт</p>
        {!!result.issues?.length&&<><p>{result.issues.length} өгүүлбэр хугацаандаа багтаагүй. Transcript-ийг “Open saved”-аар нээж засах эсвэл төслийг нээнэ.</p>
          <ul>{result.issues.slice(0,8).map(i=><li key={i.id}>{time(i.start)} · +{i.overflow.toFixed(1)} сек · {i.text}</li>)}</ul></>}
      </>}
      <div className="dub-filerow">
        {result.path&&<button className="btn" onClick={()=>window.api.showItemInFolder(result.path!)}>Видео харах</button>}
        {result.path&&<button className="btn" onClick={()=>{void importPaths([result.path!]);}}>Media-д нэмэх</button>}
        {result.projectPath&&<button className="btn" onClick={()=>window.api.showItemInFolder(result.projectPath!)}>Засах project</button>}
        {result.reportPath&&<button className="btn" onClick={()=>window.api.showItemInFolder(result.reportPath!)}>Тайлан / transcript</button>}
      </div>
    </div>}
  </div>;
}
