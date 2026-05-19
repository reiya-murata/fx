(function () {
  window.getElSafe = function getElSafe(id) {
    return document.getElementById(id);
  };

  window.setTextSafe = function setTextSafe(id, value) {
    const el = window.getElSafe(id);
    if (!el) return;
    el.textContent = value ?? "";
  };

  window.setHtmlSafe = function setHtmlSafe(id, value) {
    const el = window.getElSafe(id);
    if (!el) return;
    el.innerHTML = value ?? "";
  };

  window.setClassSafe = function setClassSafe(id, className, enabled) {
    const el = window.getElSafe(id);
    if (!el || !className) return;
    el.classList.toggle(className, Boolean(enabled));
  };
})();
