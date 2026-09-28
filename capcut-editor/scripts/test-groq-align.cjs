const fs = require('fs');
const key = fs.readFileSync('capcut-editor/groq_key.txt', 'utf8').trim();

async function testGroqAlign() {
  const prompt = 'Match Mongolian to English. English: [{"id":1,"text":"Strongest swordsman"}]. Mongolian: [{"id":0,"text":"Хамгийн хүчирхэг сэлэмчин"}]. Return JSON: {"matches":[{"id":0,"startId":1,"endId":1,"confidence":0.95}]}';
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + key },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }
    })
  });
  const data = await res.json();
  console.log('Groq status:', res.status, data);
}
testGroqAlign();
