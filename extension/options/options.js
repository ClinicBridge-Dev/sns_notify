// options 페이지는 신뢰 영역이므로 chrome.storage.local을 직접 읽고 쓴다.
(function () {
  const MBX = self.MBX;

  async function loadSettings() {
    const { settings } = await chrome.storage.local.get(['settings']);
    return Object.assign({}, MBX.DEFAULT_SETTINGS, settings);
  }

  async function saveSettings(patch) {
    const current = await loadSettings();
    const next = Object.assign({}, current, patch);
    await chrome.storage.local.set({ settings: next });
    return next;
  }

  self.MBX_OPTIONS = { loadSettings: loadSettings, saveSettings: saveSettings };
})();
