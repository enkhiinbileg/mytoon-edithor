const fs = require('fs');
const key = fs.readFileSync('capcut-editor/groq_key.txt', 'utf8').trim();

fetch('https://api.groq.com/openai/v1/models', {
  headers: { 'Authorization': 'Bearer ' + key }
})
.then(r => r.json())
.then(d => {
  console.log('Available models:', (d.data || []).map(m => m.id));
})
.catch(e => console.error(e));
