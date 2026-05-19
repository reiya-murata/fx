(function () {
  window.renderBlockingSummary = function renderBlockingSummary(summary) {
    if (!summary) return;
    const text = (value) => value === null || value === undefined || value === "" ? "-" : value;
    const yesNo = (value) => value === null || value === undefined ? "-" : (value ? "はい" : "いいえ");
    window.setTextSafe?.("blockingFinalAction", text(summary.finalAction));
    window.setTextSafe?.("blockingCandidateAction", text(summary.candidateAction));
    window.setTextSafe?.("blockingStage", text(summary.finalBlockStage));
    window.setTextSafe?.("blockingReasonJa", text(summary.reasonJa || summary.finalReason));
    window.setTextSafe?.("blockingScore", text(summary.entryEvidenceScore));
    window.setTextSafe?.("blockingCategory", text(summary.finalCategory));
    window.setTextSafe?.("blockingSuggestedFix", text(summary.suggestedFix));
    window.setTextSafe?.("blockingContextKey", text(summary.contextKey));
    window.setTextSafe?.("blockingContextSampleCount", text(summary.contextSampleCount));
    window.setTextSafe?.("blockingContextRequiredSamples", text(summary.requiredSamples));
    window.setTextSafe?.("blockingContextMode", text(summary.contextValidationMode));
    window.setTextSafe?.("blockingContextReason", text(summary.contextValidationReason));
    window.setTextSafe?.("blockingContextKnown", yesNo(summary.knownContext));
    window.setTextSafe?.("blockingContextBootstrap", yesNo(summary.bootstrapUsed));
  };
})();
