// Pure function that extracts a JSON object from an LLM text response.
// Since this relies on embedding the JSON format in the prompt rather than constrained decoding,
// the response may come mixed with a code fence (```json ... ```) or chatter before/after. This function strips that noise.

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
