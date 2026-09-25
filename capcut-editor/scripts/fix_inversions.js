const fs = require('fs');
const path = require('path');

const alignmentsPath = path.join(__dirname, '../full_story_alignments.json');
const alignmentsWithPausesPath = path.join(__dirname, '../full_story_alignments_with_pauses.json');

const al = JSON.parse(fs.readFileSync(alignmentsPath, 'utf8'));

// 1. Factory entrance & fight (211-249)
const r1 = [
  { start: 211, end: 212, vs: 882.32, ve: 891.52, en: "The blonde is damn certain that Kaido won't get past Inokami and in the end, Yuzuha will end up revealing everything. The perspective shifts to our boy who finally finds his way to the factory." },
  { start: 213, end: 213, vs: 891.52, ve: 894.84, en: "Outside are a bunch of idiots who are about to become his new victims." },
  { start: 214, end: 216, vs: 894.84, ve: 903.92, en: "Casually walking past them, the boy shows no fear while one of them quickly recognizes that he's their target. But it's already too late because this man effortlessly dismantles them with a painful strike to the neck, putting them down in an instant." },
  { start: 217, end: 219, vs: 903.92, ve: 913.08, en: "With the three men defeated, the rest of the thugs quickly charge ahead, but it's their doomsday as the high schooler mops the floor with them, shoving one of the guys into the bin." },
  { start: 220, end: 221, vs: 913.08, ve: 922.64, en: "With a murderous glare, Kaido warns the thugs not to enter his line of sight if they want to continue living their lives in one piece. And yes, the one piece is real." },
  { start: 222, end: 224, vs: 922.64, ve: 931.76, en: "Back to Tetsuya, his boss is starting to feel concerned that the kid isn't showing up, even wondering if the boy decided to chicken out. He's a kid after all..." },
  { start: 225, end: 226, vs: 931.76, ve: 940.8, en: "but only the blonde scumbag knows that what he fought on the rooftop wasn't a kid, but a demon. He tries to reason with his leader, Suo, assuring him that their opponent isn't normal." },
  { start: 227, end: 228, vs: 940.8, ve: 950.68, en: "Speaking of the devil, they hear their men chanting Fujiwara's name just outside the factory. Yuzuha is shocked while the blonde coward is terrified for his life." },
  { start: 229, end: 229, vs: 950.68, ve: 952.64, en: "The door bashes open as a man's body is flung like a paper ball, landing right next to Tetsuya's feet." },
  { start: 230, end: 232, vs: 952.64, ve: 961.64, en: "Excited, the muscle maniac turns to meet his target. Meanwhile, the seemingly harmless boy reminds Tetsuya of his warning from last time. This man is having a hard time holding back his strength just so that he doesn't kill these guys." },
  { start: 233, end: 233, vs: 961.64, ve: 968.84, en: "Mr. Suo is baffled, questioning how one child was able to annihilate 20 thugs all on his own." },
  { start: 234, end: 234, vs: 968.84, ve: 973.04, en: "Casually adjusting his tie for maximum aura, Kaido demands to see his friend." },
  { start: 235, end: 235, vs: 973.04, ve: 976.84, en: "Yuzuha's scream surges throughout the factory, worried that he came for her." },
  { start: 236, end: 237, vs: 976.84, ve: 986.8, en: "Thanks to her voice, he knows that she's exactly 30 m ahead. He's glad that she's doing okay and scans his environment for the hostile men ready to attack him." },
  { start: 238, end: 239, vs: 986.8, ve: 997.2, en: "In the span of what appears to be no more than 53 seconds, this man speed blitzes the hell out of the room, shocking the boss with his godlike ability as he takes down every man around. Even Tetsuya is crawling..." },
  { start: 240, end: 240, vs: 997.2, ve: 1006.64, en: "The fear of death looms over him as our boy grabs Tetsuya before locking a fist, promising to make him suffer quite a bit." },
  { start: 241, end: 241, vs: 1006.64, ve: 1016.32, en: "In the next few moments, this man throws lightning-fast punches, precisely shattering Tetsuya's clavicles, his lower ribs, and elbows." },
  { start: 242, end: 243, vs: 1016.32, ve: 1025.4, en: "As if that excruciating pain wasn't enough, the dude slams him into the nearest wall with a simple push. Mr. Suo's men are all terrified and absolutely don't want to get smoked by our boy." },
  { start: 244, end: 246, vs: 1025.4, ve: 1034.2, en: "They want to make a run for it, but he reminds them he's paying them for the job. Suo is starting to realize the true level of danger they're dealing with. Their target isn't a helpless boy, but a monster." },
  { start: 247, end: 249, vs: 1034.2, ve: 1043.4, en: "Thanks to being blindfolded, Yuzuha hasn't seen a thing. He goes up to her and assures her that everything is going to be all right. Right as our boy is about to untie her ropes, the behemoth shoves his fist to slam him." },
];
r1.forEach(r => {
  for (let i = r.start; i <= r.end; i++) {
    al[i].videoStart = r.vs;
    al[i].videoEnd = r.ve;
    if (r.en) al[i].englishText = r.en;
  }
});

// 2. Lance fight (350-351)
al[350].videoStart = 1476.32; al[350].videoEnd = 1486.32; al[350].englishText = "This time the blade scratches Kaido and blood drops.";
al[351].videoStart = 1476.32; al[351].videoEnd = 1486.32; al[351].englishText = "He realizes that he's dealing with a powerful lance.";

// 3. Makoto transfer & rooftop (526-559)
const r3 = [
  { start: 526, end: 528, vs: 2261.4, ve: 2271.52, en: "The top 12 are known as the legendary spears who are commanded by their supreme leader Odin. Each of these insanely overpowered assassins has extraordinary abilities that rival a thousand men." },
  { start: 529, end: 530, vs: 2271.52, ve: 2280.32, en: "When it comes to assassinations, these people can easily trample over the army of an entire nation. These elite warriors are only deployed for the most critical missions..." },
  { start: 531, end: 532, vs: 2280.32, ve: 2289.04, en: "which makes Kaito come to the conclusion that it can only mean they are hell-bent on targeting Yuzuha. Kaito looks down in sadness as the painful memories from his last mission hit him..." },
  { start: 533, end: 534, vs: 2289.04, ve: 2299.28, en: "and he figures that the assassins must be after the secret treasure that the chairman has supposedly stolen from them. It keeps bothering him if he can protect everyone..." },
  { start: 535, end: 535, vs: 2299.28, ve: 2302.72, en: "including his childhood friend, with his current body of a high schooler?" },
  { start: 536, end: 537, vs: 2302.72, ve: 2312.12, en: "Sometime later, everyone returns to their classroom, but the students still do not stop fan girling over Makoto and keep begging him to join them for karaoke..." },
  { start: 538, end: 538, vs: 2312.12, ve: 2321.52, en: "He is an instant hit with the ladies who start crushing on him even harder once he reveals that he practiced a bit of basketball back in the United States." },
  { start: 539, end: 539, vs: 2321.52, ve: 2323.6, en: "Meanwhile, our hero watches the situation from a distance and realizes Akatsuki is not making his move today." },
  { start: 540, end: 541, vs: 2323.6, ve: 2332.68, en: "And he makes a mental note to stay on full guard tomorrow. Just then, he hears Yuzuha call out to him and ask if he can go somewhere with her after school." },
  { start: 542, end: 543, vs: 2332.68, ve: 2341.84, en: "Our boy instantly rejects her offer without even hearing her out, insisting she should just go straight home for the day. However, out of nowhere, a hand rests on his shoulder and Makoto appears from behind..." },
  { start: 544, end: 545, vs: 2341.84, ve: 2351.72, en: "by her name, which instantly sets off all sorts of red flags for Kaito that he is seriously after Yuzuha. Makoto introduces himself..." },
  { start: 546, end: 546, vs: 2351.72, ve: 2361.92, en: "but Yuzuha points out he is already quite famous as the hot new guy all over the school and she asks how he even knows her name since they have never actually met." },
  { start: 547, end: 548, vs: 2361.92, ve: 2371.56, en: "The cheerful transfer student tells her with a carefree smile that she is the high school girl who inherited the Akagi Group fortune... She suddenly gets a bit depressed..." },
  { start: 549, end: 549, vs: 2371.56, ve: 2380.44, en: "But when he tries to invite her somewhere, our boy suddenly cuts in and makes an excuse that he hurt his finger during practice and actually needs to go to the nurse." },
  { start: 550, end: 551, vs: 2380.44, ve: 2390.32, en: "Our boy gives him a cold death stare, which convinces him to play along, and the two boys part ways with Yuzuha. She looks back with a smile and thanks Kaito..." },
  { start: 552, end: 553, vs: 2390.32, ve: 2399.56, en: "A few moments later, as the two are standing on the rooftop, Makoto admires the view and goes on about how wonderful the prime time of a high schooler's youth is." },
  { start: 554, end: 555, vs: 2399.56, ve: 2408.44, en: "He then looks back at Kaito and jokingly asks if he brought him here to confess his love or something, but our boy keeps giving him the silent treatment." },
  { start: 556, end: 556, vs: 2408.44, ve: 2411.8, en: "Makoto simply laughs it off and continues that Yuzuha is honestly quite cute up close and personal, but says he cannot believe that she is the chairman's daughter." },
  { start: 557, end: 559, vs: 2411.8, ve: 2422.16, en: "Kaito gets straight to the point and demands to know what his goal for coming here really is, wondering if it is revenge for the purple-haired guy. The transfer student looks as unbothered as ever and casually asks if he is actually the one who took out Sanjo." },
];
r3.forEach(r => {
  for (let i = r.start; i <= r.end; i++) {
    al[i].videoStart = r.vs;
    al[i].videoEnd = r.ve;
    if (r.en) al[i].englishText = r.en;
  }
});

// 4. Gungnir reveal (594-596)
al[594].videoStart = 2582.92; al[594].videoEnd = 2591.8;
al[595].videoStart = 2582.92; al[595].videoEnd = 2591.8; al[595].englishText = "The mention of that name makes Makoto look at him with a murderous gaze, enraged that he would dare utter the name of Gungnir.";
al[596].videoStart = 2582.92; al[596].videoEnd = 2591.8; al[596].englishText = "Kaito calmly reveals that he was once known as Gungnir.";

// 5. Mirai memory & dog John (630-645)
const r5 = [
  { start: 630, end: 632, vs: 2752.8, ve: 2763.0, en: "Now weeping like a widower, our protagonist grieves that he could not make her happy. Mirai only remains in his memories. After that, he returns home and tells his family that a couple had to give up their dog..." },
  { start: 633, end: 634, vs: 2763.0, ve: 2773.3, en: "Before he can try to convince them further, Taro immediately agrees to adopt the dog and Kyoto suggests they take it to the vet... When asked for the dog's name, he says the previous owners called him John." },
  { start: 635, end: 637, vs: 2773.3, ve: 2782.1, en: "After that, he texts Yuzuha to ask if anything has happened yet, and she says things are rather boring... asking if she can come over and pet the dog." },
  { start: 638, end: 640, vs: 2782.1, ve: 2791.2, en: "Kaito smiles at his phone because he knows what he must do. After that, he calls Akatsuki who is surprised that he has already made up his mind before the three days are up." },
  { start: 641, end: 642, vs: 2791.2, ve: 2801.0, en: "Kaito says he's had enough games and is ready to give Akatsuki a beating on the school rooftop before classes start at dawn, because he is Gungnir." },
  { start: 643, end: 644, vs: 2801.0, ve: 2811.0, en: "Hearing the name Gungnir, Akatsuki gets so enraged that he smashes the phone in his hand. In his mind, someone like Gungnir was the epitome of a ruthless killer..." },
  { start: 645, end: 645, vs: 2811.0, ve: 2820.2, en: "and he can't believe a mere schoolboy dares to claim the name Gungnir right in front of him." },
];
r5.forEach(r => {
  for (let i = r.start; i <= r.end; i++) {
    al[i].videoStart = r.vs;
    al[i].videoEnd = r.ve;
    if (r.en) al[i].englishText = r.en;
  }
});

// 6. Duel sensory (700-704)
al[700].videoStart = 3023.56; al[700].videoEnd = 3032.96; al[700].englishText = "He absorbs all of Akatsuki's rage and simply stands his ground.";
al[701].videoStart = 3032.96; al[701].videoEnd = 3041.88; al[701].englishText = "Akatsuki senses that something is wrong with this sudden shift...";
al[702].videoStart = 3032.96; al[702].videoEnd = 3041.88; al[702].englishText = "Meanwhile, Kaido holds his head as his senses become so sharp...";
al[703].videoStart = 3032.96; al[703].videoEnd = 3041.88; al[703].englishText = "...he can feel every object around him.";
al[704].videoStart = 3041.88; al[704].videoEnd = 3045.76; al[704].englishText = "Caught off guard by the sudden change in attitude, Akatsuki wonders what exactly just happened.";

// 7. Argos revelation (874-882)
al[874].videoStart = 3778.8; al[874].videoEnd = 3788.9; al[874].englishText = "revealing that the order to assassinate him was given by his former partner, Hayate.";
al[875].videoStart = 3778.8; al[875].videoEnd = 3788.9; al[875].englishText = "At the mention of that name, our hero's expression quickly shifts to sheer fury.";
al[876].videoStart = 3788.9; al[876].videoEnd = 3795.2; al[876].englishText = "Kuji continues that the order was top secret and only a few people knew, one of them being himself.";
al[877].videoStart = 3788.9; al[877].videoEnd = 3795.2; al[877].englishText = "He says that he leaked all the information which allowed Toji's brain to be preserved.";
al[878].videoStart = 3795.2; al[878].videoEnd = 3801.0; al[878].englishText = "Hearing that, Kaido asks if that means Kuji betrayed the organization.";
al[879].videoStart = 3801.0; al[879].videoEnd = 3809.6; al[879].englishText = "Kuji answers that they are members of Argos, a special unit operating directly under the Japanese government.";
al[880].videoStart = 3801.0; al[880].videoEnd = 3809.6; al[880].englishText = "The sole purpose of this unit is to destroy the Great Will Organization.";
al[881].videoStart = 3809.6; al[881].videoEnd = 3819.5; al[881].englishText = "He adds that they are more commonly known as Argos and that the reason they intervened was to secure Toji's abilities.";
al[882].videoStart = 3809.6; al[882].videoEnd = 3819.5; al[882].englishText = "Kaido connects the dots, realizing his brain was handled by the Japanese government.";

// Check monotonicity
let errors = 0;
for (let i = 1; i < al.length; i++) {
  if (al[i].videoStart < al[i - 1].videoStart) {
    console.error('Monotonicity error at', i, al[i - 1].videoStart, al[i].videoStart);
    errors++;
  }
}

if (errors === 0) {
  console.log('✅ Verified 0 monotonicity errors. Saving files...');
  fs.writeFileSync(alignmentsPath, JSON.stringify(al, null, 2), 'utf8');
  fs.writeFileSync(alignmentsWithPausesPath, JSON.stringify(al, null, 2), 'utf8');
  console.log('✅ Successfully updated full_story_alignments.json and full_story_alignments_with_pauses.json!');
} else {
  console.error(`❌ Found ${errors} errors, not saving!`);
}
