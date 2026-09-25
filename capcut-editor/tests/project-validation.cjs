const assert=require('node:assert/strict');
const {validateProject}=require('../electron/project-store');
const valid={format:'cutline-project',version:1,name:'Test',settings:{width:1920,height:1080,fps:30},media:[],tracks:[{id:'text',name:'Text',kind:'overlay',hidden:false,muted:false,locked:false}],clips:[{id:'a',kind:'text',trackId:'text',start:0,inPoint:0,outPoint:2,style:{text:'Hello\nWorld',fontSize:64,color:'#fff',background:'',bold:false,shadow:true}}]};
assert.deepEqual(validateProject(valid),valid);
assert.throws(()=>validateProject({...valid,version:2}));
assert.throws(()=>validateProject({...valid,clips:[{...valid.clips[0],start:NaN}]}));
assert.throws(()=>validateProject({...valid,clips:[{...valid.clips[0],trackId:'missing'}]}));
assert.throws(()=>validateProject({...valid,clips:[valid.clips[0],valid.clips[0]]}));
assert.throws(()=>validateProject({...valid,settings:{width:1919,height:1080,fps:30}}));
assert.equal(validateProject({...valid,apiKey:'never serialize secrets'}).apiKey,undefined);
const withKf = {
  ...valid,
  clips: [{
    ...valid.clips[0],
    rotation: 45,
    keyframes: [{ id: 'kf1', time: 0, scale: 1, x: 0.5, y: 0.5, rotation: 0, opacity: 1 }]
  }]
};
assert.deepEqual(validateProject(withKf), withKf);
console.log('Project schema: valid round trip, keyframes, version, timing, references, duplicate IDs, settings, field whitelist passed.');
