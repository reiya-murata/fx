const REASON_REPLACEMENTS = [
  ["momentum too negative for buy", "買い方向に対して短期モメンタムが弱すぎます"],
  ["momentum too positive for sell", "売り方向に対して短期モメンタムが強すぎます"],
  ["spread too wide for range momentum", "レンジ内モメンタム狙いにはスプレッドが広すぎます"],
  ["blocked: No trade signal", "売買シグナルなし"],
  ["validation-only: unvalidated context", "未検証コンテキストのため検証モードで停止"],
  ["context validation", "相場コンテキスト検証"],
  ["unvalidated context", "未検証の相場コンテキスト"],
  ["confidence below floor", "信頼度が必要水準を下回っています"],
  ["edge below cost-aware threshold", "コスト考慮後の優位性が必要水準を下回っています"],
  ["spread too high", "スプレッドが許容値を超えています"],
  ["execution stress too high", "約定ストレスが高すぎます"]
];

export function translateReasonToJa(reason) {
  if (reason === null || reason === undefined || reason === "") return "";
  let text = Array.isArray(reason)
    ? reason.map((item) => translateReasonToJa(item)).join("、")
    : String(reason);

  for (const [from, to] of REASON_REPLACEMENTS) {
    text = text.replaceAll(from, to);
  }
  return text;
}
