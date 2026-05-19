(function () {
  window.renderBlockingSummary = function renderBlockingSummary(summary) {
    if (!summary) return;
    window.setTextSafe?.("blockingFinalAction", summary.finalAction);
    window.setTextSafe?.("blockingCandidateAction", summary.candidateAction);
    window.setTextSafe?.("blockingStage", summary.finalBlockStage);
    window.setTextSafe?.("blockingReasonJa", summary.reasonJa || summary.finalReason);
    window.setTextSafe?.("blockingSuggestedFix", summary.suggestedFix);
  };
})();
