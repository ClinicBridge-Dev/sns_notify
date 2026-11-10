const $ = (id) => document.getElementById(id);
chrome.storage.local.get(['serverUrl', 'token']).then((s) => {
  $('serverUrl').value = s.serverUrl || 'http://localhost:8787';
  $('token').value = s.token || '';
});
$('save').addEventListener('click', async () => {
  await chrome.storage.local.set({ serverUrl: $('serverUrl').value.trim() || 'http://localhost:8787', token: $('token').value.trim() });
  $('msg').textContent = '저장했습니다';
});
