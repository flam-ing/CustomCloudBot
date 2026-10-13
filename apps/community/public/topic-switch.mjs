// Deliberately conservative: this is a local hint, not an AI topic classifier.
// Unknown, quoted, or ambiguous tasks should never interrupt a send.
const domains = [
  ["project", [
    /(?:앱|웹사이트|사이트|프로젝트|저장소|컴포넌트|소스\s*코드|코딩|개발|\b(?:app|website|project|repository|repo|component|code|coding|development)\b)/iu,
    /(?:버그|배포|서버|데이터베이스|로그인|인증|오류|기능|\b(?:bug|deploy\w*|server|database|api|docker|react|javascript|typescript|python|test|tests)\b)/iu,
    /(?:로고|디자인|아이콘|화면|레이아웃|인터페이스|애니메이션|\b(?:ui|ux|css|logo|design|icon|layout|interface|animation)\b)/iu,
  ]],
  ["travel", [
    /(?:여행|휴가|관광|출장|\b(?:travel|trip|vacation|itinerary|sightseeing)\b)/iu,
    /(?:항공권|비행기|호텔|숙소|여권|렌터카|\b(?:flight|flights|hotel|hotels|accommodation|passport)\b)/iu,
    /(?:\d+\s*박|\d+\s*일\s*(?:일정|코스)|여행\s*(?:일정|계획|코스)|\b(?:weekend|day|days|week)\s+(?:trip|itinerary)\b)/iu,
  ]],
  ["food", [
    /(?:요리|레시피|\b(?:recipe|recipes|cook|cooking)\b)/iu,
    /(?:식단|저녁|점심|아침|도시락|\b(?:meal|meals|dinner|lunch|breakfast)\b)/iu,
    /(?:재료|냉장고|닭가슴살|파스타|볶음밥|국물|\b(?:ingredient|ingredients|chicken|pasta|rice|vegetarian)\b)/iu,
  ]],
  ["fitness", [
    /(?:운동|헬스|다이어트|\b(?:workout|fitness|exercise|training)\b)/iu,
    /(?:근력|근육|유산소|스쿼트|체중|살\s*빼|체지방|\b(?:strength|muscle|cardio|squat|weight|fat)\b)/iu,
    /(?:운동\s*(?:계획|루틴|일정)|헬스\s*루틴|\bworkout\s+(?:plan|routine|schedule)\b)/iu,
  ]],
  ["health", [
    /(?:증상|통증|두통|발열|기침|복통|\b(?:symptom|symptoms|pain|headache|fever|cough)\b)/iu,
    /(?:병원|진료|의사|약국|치료|건강|\b(?:hospital|doctor|clinic|treatment|health|medical)\b)/iu,
    /(?:아프|아픈|다쳤|다친|\b(?:hurt|hurts|injury|injured|sick)\b)/iu,
  ]],
  ["finance", [
    /(?:주식|펀드|적금|예금|대출|연금|채권|\b(?:stocks?|funds?|etfs?|loan|loans|pension|bonds?|mortgage)\b)/iu,
    /(?:투자|이자|금리|자산|수익률|배당|\b(?:invest\w*|interest|assets?|dividend|returns?)\b)/iu,
    /(?:가계부|재무|저축|재테크|\b(?:savings?|financial|budgeting)\b)/iu,
  ]],
  ["career", [
    /(?:이력서|자기소개서|자소서|경력\s*기술서|\b(?:resume|cv|cover\s+letter)\b)/iu,
    /(?:취업|채용|면접|지원서|구직|이직|\b(?:interview|recruitment|job\s+(?:search|application)|career)\b)/iu,
    /(?:자기\s*소개|지원\s*동기|경력|\b(?:experience|qualifications?|hiring)\b)/iu,
  ]],
  ["learning", [
    /(?:시험|공부|학습|문제집|\b(?:exam|study|studying|homework|lesson)\b)/iu,
    /(?:수학|영어|물리|화학|한국사|토익|토플|\b(?:math|mathematics|english|physics|chemistry|history|ielts|toefl)\b)/iu,
    /(?:학습\s*계획|공부\s*계획|시험\s*준비|\b(?:study\s+plan|exam\s+prep)\b)/iu,
  ]],
  ["correspondence", [
    /(?:메일|이메일|편지|초대장|\b(?:email|e-mail|letter|invitation)\b)/iu,
    /(?:답장|회신|받은\s*편지|받은\s*메일|\b(?:reply|respond|inbox|received)\b)/iu,
    /(?:초안|작성|보내|발송|\b(?:draft|write|send)\b)/iu,
  ]],
  ["writing", [
    /(?:소설|동화|에세이|시나리오|\b(?:novel|fiction|poem|poetry|essay|screenplay)\b)/iu,
    /(?:줄거리|주인공|등장인물|문체|\b(?:plot|character|characters|protagonist|story)\b)/iu,
    /(?:집필|글쓰기|창작|\b(?:creative\s+writing|narrative|chapter)\b)/iu,
  ]],
];

const request = /(?:해\s*줘|해\s*주|해주세요|해줄|해볼|하자|할래|하고\s*싶|해야|알려|짜\s*줘|짜\s*주|추천|계획|정리|준비|만들|수정|분석|비교|작성|찾아|설계|계산|고쳐|도와|\b(?:help|please|plan|create|make|write|draft|fix|build|find|recommend|compare|explain|design|prepare|calculate|summari[sz]e)\b)/iu;
const projectAction = /(?:구현|개발|코딩|디버깅|배포|\b(?:implement\w*|develop\w*|cod(?:e|ing)|debug\w*|deploy\w*)\b)/iu;
const projectObject = /(?:앱|웹사이트|사이트|프로젝트|컴포넌트|코드|기능|페이지|대시보드|\b(?:app|website|project|component|code|feature|page|dashboard)\b)/iu;
const projectEdit = /(?:만들|추가|넣어|넣고|고쳐|수정|바꿔|디자인|\b(?:build|create|add|implement|fix|change|update|design)\b)/iu;
const explicitSwitch = /(?:다른\s*(?:얘기|이야기|주제|일|업무)|별개(?:로|의|인)|전혀\s*다른|완전히\s*다른|\b(?:unrelated|different\s+(?:topic|task|subject)|switch\s+(?:topics?|tasks?))\b)/iu;
const reference = /^(?:(?:아니|그럼|그리고|그래서|근데|그런데|이제|응|네)\s*[,.:]?\s*)*(?:그거|그걸|그것|이거|이걸|이것|그대로|아까|방금|위의|이어서|계속|추가로|같은|하던|(?:이|그|현재)\s*(?:앱|사이트|프로젝트|코드|기능|작업|내용)|(?:for|in|on|with)\s+(?:this|that|the\s+same)\b|(?:continue|continuing|same|that|this|as\s+above)\b)/iu;

function instructionText(value) {
  return String(value ?? "").slice(0, 4000)
    // Untrusted source material must not supply topic-change evidence.
    .replace(/(```|~~~)[\s\S]*?(?:\1|$)/gu, " ")
    .replace(/^(?:\s*>| {4}|\t).*$/gmu, " ")
    .replace(/`[^`]*`|"[^"\n]*"|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』/gu, " ")
    .replace(/!?\[[^\]]*\]\([^)]*\)|https?:\/\/\S+/giu, " ")
    .replace(/\s+/gu, " ").trim();
}

function taskDomain(text) {
  const matches = domains.map(([id, markers]) => ({id, score: markers.filter(marker => marker.test(text)).length})).filter(match => match.score >= 2);
  // Work on a travel/finance/etc. feature is still work on the same product.
  const project = matches.find(match => match.id === "project");
  if ((project && projectAction.test(text)) || (projectObject.test(text) && (projectAction.test(text) || projectEdit.test(text)))) return "project";
  // Multiple plausible domains mean insufficient evidence for an interruption.
  return matches.length === 1 ? matches[0].id : null;
}

function isHuman(message) {
  return message?.kind === "human" || message?.role === "user" || message?.senderType === "human" || message?.senderType === "user";
}

const related = new Set(["fitness:food", "fitness:health", "food:health"]);

/**
 * High-precision, best-effort local suggestion. History is chronological.
 * @param {{history?: Array<{kind?:string,role?:string,senderType?:string,text?:string,content?:string}>, draft?:string, previousSuggestion?:string|{draft?:string}}} input
 * @returns {{suggest:boolean, reason?:'different-task'}}
 */
export function suggestTopicSwitch({history = [], draft = "", previousSuggestion} = {}) {
  const text = instructionText(draft);
  const previous = typeof previousSuggestion === "string" ? previousSuggestion : previousSuggestion?.draft;
  if (text.length < 18 || !request.test(text) || (previous != null && instructionText(previous) === text)) return {suggest: false};
  if (reference.test(text) && !explicitSwitch.test(text)) return {suggest: false};
  const next = taskDomain(text);
  if (!next) return {suggest: false};

  const recent = (Array.isArray(history) ? history : []).filter(isHuman).slice(-6);
  for (let index = recent.length - 1; index >= 0; index--) {
    const prior = instructionText(recent[index].text ?? recent[index].content);
    // Brief acknowledgments and pasted sources don't change the active task.
    if (prior.length < 24) continue;
    const current = taskDomain(prior);
    // Do not reach past a substantive but unrecognized or mixed task.
    if (!current) return {suggest: false};
    if (current === next || related.has([current, next].sort().join(":"))) return {suggest: false};
    return {suggest: true, reason: "different-task"};
  }
  return {suggest: false};
}
