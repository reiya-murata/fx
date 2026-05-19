(function () {
  window.formatNumber = function formatNumber(value, digits = 2) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
    return Number(value).toFixed(digits);
  };

  window.formatPips = function formatPips(value, digits = 2) {
    const text = window.formatNumber(value, digits);
    return text === "-" ? "-" : `${text} pips`;
  };

  window.formatJpy = function formatJpy(value, options = {}) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    const prefix = options.approx ? "約" : "";
    return `${prefix}${Math.round(n).toLocaleString("ja-JP")}円`;
  };

  window.formatPercentValue = function formatPercentValue(value, digits = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    return `${window.formatNumber(n * 100, digits)}%`;
  };

  window.formatDateTime = function formatDateTime(value) {
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return "-";
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(d);
  };
})();
