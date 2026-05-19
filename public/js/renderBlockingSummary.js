(function () {
  window.renderBlockingSummary = function renderBlockingSummary(summary) {
    if (!summary) return;
    const text = (value) => value === null || value === undefined || value === "" ? "-" : value;
    window.setTextSafe?.("blockingFinalAction", text(summary.finalAction));
    window.setTextSafe?.("blockingCandidateAction", text(summary.candidateAction));
    window.setTextSafe?.("blockingStage", text(summary.finalBlockStage));
    window.setTextSafe?.("blockingReasonJa", text(summary.reasonJa || summary.finalReason));
    window.setTextSafe?.("blockingScore", text(summary.entryEvidenceScore));
    window.setTextSafe?.("blockingCategory", text(summary.finalCategory));
    window.setTextSafe?.("blockingSuggestedFix", text(summary.suggestedFix));
  };
})();
