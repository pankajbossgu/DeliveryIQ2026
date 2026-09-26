/* Shared by Node validation and the browser upload UI. */
(function (root) {
  const limits = Object.freeze({ maxSourceRows: 35000, maxFileBytes: 10 * 1024 * 1024 });
  if (typeof module !== 'undefined' && module.exports) module.exports = limits;
  else root.DeliveryIQLimits = limits;
})(typeof globalThis !== 'undefined' ? globalThis : this);
