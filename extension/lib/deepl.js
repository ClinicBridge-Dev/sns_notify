(function (root) {
  const NO_KEY = { code: 'NO_KEY', message: 'DeepL 키를 설정하세요' };
  const TOO_LONG = { code: 'TOO_LONG', message: '번역할 수 있는 길이(5000자)를 넘었습니다' };

  function deeplBase(key) {
    return /:fx$/.test(key || '') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  }

  function authHeaders(key) {
    return { Authorization: 'DeepL-Auth-Key ' + key, 'Content-Type': 'application/json' };
  }

  function buildTranslateRequest(req, key) {
    const body = { text: [req.text], target_lang: req.targetLang };
    // 전송용 번역은 source_lang을 KO로 고정한다(한영 혼합 문장의 결과 안정).
    if (req.purpose === 'send') body.source_lang = 'KO';
    return {
      url: deeplBase(key) + '/v2/translate',
      init: { method: 'POST', headers: authHeaders(key), body: JSON.stringify(body) }
    };
  }

  function buildUsageRequest(key) {
    return {
      url: deeplBase(key) + '/v2/usage',
      init: { method: 'GET', headers: { Authorization: 'DeepL-Auth-Key ' + key } }
    };
  }

  // status 0 = 네트워크 오류 또는 시간 초과
  function mapDeeplError(status) {
    if (status === 403) return { code: 'BAD_KEY', message: 'DeepL 키가 올바르지 않습니다' };
    if (status === 456) return { code: 'QUOTA', message: 'DeepL 사용 한도를 초과했습니다' };
    return { code: 'RETRY', message: '잠시 후 다시 시도하세요' };
  }

  root.NO_KEY = NO_KEY;
  root.TOO_LONG = TOO_LONG;
  root.deeplBase = deeplBase;
  root.buildTranslateRequest = buildTranslateRequest;
  root.buildUsageRequest = buildUsageRequest;
  root.mapDeeplError = mapDeeplError;
})(typeof module !== 'undefined' && module.exports ? module.exports : (self.MBX = self.MBX || {}));
