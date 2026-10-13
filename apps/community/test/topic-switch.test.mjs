import test from "node:test";
import assert from "node:assert/strict";
import {suggestTopicSwitch} from "../public/topic-switch.mjs";

const project = [
  {kind: "human", text: "커뮤니티 앱의 로그인 오류를 고쳐주고 서버에 배포해줘. 기존 코드와 설정은 유지해줘."},
  {kind: "bot", text: "수정했습니다. 다음으로 여행 일정도 만들 수 있어요."},
];
const travel = "이번 주말 도쿄로 여행 가는데 2박 3일 일정 짜줘. 숙소도 추천해줘.";
const suggest = (draft, history = project, extra = {}) => suggestTopicSwitch({history, draft, ...extra}).suggest;

test("clear unrelated Korean and English tasks can suggest a new conversation", () => {
  assert.equal(suggest(travel), true);
  assert.equal(suggest("다른 얘기인데 오늘 저녁 닭가슴살 요리 레시피를 추천해줘."), true);
  assert.equal(suggest("받은 이메일을 읽고 고객에게 보낼 답장 초안을 작성해줘."), true);
  assert.equal(suggest("I need help planning a weekend trip and finding a hotel in Tokyo.", [
    {role: "user", content: "Please fix the login bug in this React app and deploy the updated server."},
  ]), true);
  assert.equal(suggest("이제 이직을 준비하려고 해. 이력서의 경력 소개와 면접 준비 계획을 작성해줘."), true);
});

test("same-product implementation, design and parallel subtasks stay together", () => {
  for (const draft of [
    "커뮤니티 앱의 아이콘 디자인과 로그인 화면 레이아웃을 바꿔줘.",
    "앱에 여행 일정 추천 기능을 추가하고 호텔 검색 페이지도 만들어줘.",
    "이메일 답장 기능을 구현하고 API 인증 오류도 수정해줘.",
    "이제 주식 투자 수익률 대시보드 페이지를 만들어줘.",
    "이어서 도쿄 여행 페이지의 UI를 다듬고 호텔 검색도 추가해줘.",
    "같은 프로젝트에서 이메일 답장 초안 작성 부분을 수정해줘.",
    "로그인 버그 수정과 서버 테스트를 병렬로 진행할 수 있게 도와줘.",
  ]) assert.equal(suggest(draft), false, draft);
});

test("short replies, referential followups and unknown topics don't interrupt", () => {
  for (const draft of [
    "응", "좋아 그렇게 해줘", "새로운 일", "그거 그대로 해줘",
    "그걸 바탕으로 여행 일정과 호텔 추천을 정리해줘.",
    "For that project, please plan a weekend trip and recommend hotels.",
    "완전히 다른 이야기인데 내일 무엇을 해야 할지 정리해줘.",
  ]) assert.equal(suggest(draft), false, draft);
  assert.equal(suggest(travel, []), false);
  assert.equal(suggest(travel, [{kind: "human", text: "안녕"}]), false);
  assert.equal(suggest(travel, [{kind: "human", text: "일상에서 할 수 있는 재미있는 일이 무엇인지 길고 자세히 이야기해줘."}]), false);
});

test("quoted data, code, URLs and assistant messages cannot introduce the topic", () => {
  for (const draft of [
    "아래 문장을 요약해서 알려줘.\n> 여행을 계획하고 호텔을 추천해줘. 2박 3일 여행 일정이 필요해.",
    "아래 문자열을 분석해서 알려줘.\n```text\n여행을 계획하고 호텔을 추천해줘. 2박 3일 여행 일정이 필요해.\n```",
    "아래 문자열을 분석해서 알려줘.\n~~~text\n여행을 계획하고 호텔을 추천해줘. 2박 3일 여행 일정이 필요해.",
    "다음 문장을 분석해서 알려줘: “여행을 계획하고 호텔을 추천해줘. 2박 3일 여행 일정이 필요해.”",
    "이 링크 내용을 정리해줘: https://example.com/travel/hotel/weekend-trip",
  ]) assert.equal(suggest(draft), false, draft);
  assert.equal(suggest(travel, [{kind: "bot", text: project[0].text}]), false);
  assert.equal(suggest(travel, [{role: "system", content: project[0].text}]), false);
  assert.equal(suggest(travel, [{kind: "human", text: `이 자료를 요약해줘.\n> ${project[0].text}`}]), false);
});

test("the latest human task controls suggestions and an accepted change stops repeating", () => {
  assert.equal(suggest(travel, [...project, {kind: "human", text: "고마워"}]), true);
  assert.equal(suggest("이번 여행에서 항공권과 호텔 가격도 비교해줘.", [...project, {kind: "human", text: travel}]), false);
  assert.equal(suggest(travel, [...project, {kind: "human", text: "지금은 내용이 긴 다른 주제를 설명하고 있지만 어떤 종류인지는 명확하지 않습니다."}]), false);
  assert.equal(suggest(travel, project, {previousSuggestion: travel}), false);
  assert.equal(suggest(travel, project, {previousSuggestion: {draft: travel}}), false);
});

test("related lifestyle work and mixed requests remain in their current context", () => {
  const fitness = [{kind: "human", text: "헬스장에서 근력 운동과 유산소 운동을 번갈아 할 수 있게 운동 계획을 작성해줘."}];
  assert.equal(suggest("근육을 키울 때 먹을 저녁 식단과 닭가슴살 레시피를 추천해줘.", fitness), false);
  assert.equal(suggest("운동 후 무릎 통증이 있는데 어느 병원에서 진료받으면 좋을지 알려줘.", fitness), false);
  assert.equal(suggest("도쿄 여행을 위한 호텔을 찾아주고 취업 면접용 이력서도 작성해줘."), false);
});

test("bounded and malformed inputs fail closed", () => {
  assert.deepEqual(suggestTopicSwitch(), {suggest: false});
  assert.equal(suggestTopicSwitch({history: null, draft: travel}).suggest, false);
  assert.equal(suggestTopicSwitch({history: [null, 7, {}, {kind: "bot"}], draft: travel}).suggest, false);
  const prior = project[0];
  assert.equal(suggest(travel, [prior, ...Array.from({length: 6}, () => ({kind: "human", text: "네"}))]), false);
  assert.equal(suggest("a".repeat(4000) + travel), false);
});
