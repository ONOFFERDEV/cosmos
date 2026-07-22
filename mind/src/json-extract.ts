// LLM 텍스트 응답에서 JSON 객체를 추출하는 순수 함수.
// 제약된 디코딩 없이 프롬프트에 JSON 형식을 박아 넣는 방식이므로, 응답에는
// 코드펜스(```json ... ```)나 전후 잡담이 섞여 나올 수 있다. 이 함수가 그 잡음을 걷어낸다.

export function extractJson(text: string): unknown {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenceMatch ? fenceMatch[1]! : text;

  const start = candidate.indexOf("{");
  if (start === -1) {
    throw new Error("응답에서 JSON 객체를 찾을 수 없습니다.");
  }

  let depth = 0;
  let end = -1;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) {
    throw new Error("JSON 객체가 올바르게 닫히지 않았습니다.");
  }

  const jsonStr = candidate.slice(start, end + 1);
  return JSON.parse(jsonStr);
}
