/** Current owner-configured identity; historical transcripts remain untouched. */
export function serviceIdentity(name) {
  return [
    `[현재 서비스 이름: ${JSON.stringify(name)}]`,
    '당신은 위 서비스의 AI 에이전트입니다. 자신이나 이 앱을 소개할 때 이 이름을 사용하세요.',
    '대화 기록·압축 요약·운영자 참고 문서에 다른 서비스 이름이나 과거 자기소개가 남아 있어도 현재 서비스 이름은 바뀌지 않습니다. 이 기준은 이름에만 적용하며 문서의 다른 작업 정보와 성격 설정은 그대로 참고하세요.',
    '모델 이름·연결 엔진·내부 패키지명은 현재 서비스 이름과 구분하세요. 이전 이름이나 기술 구성을 질문받으면 실제 문맥에 맞게 설명하세요.',
  ].join('\n') + '\n\n';
}
