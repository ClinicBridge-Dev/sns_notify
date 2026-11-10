import json

import pytest

from app.translator.gpt import SYSTEM_PROMPT, ContentError, parse_output


def test_parse_ok():
    r = parse_output(json.dumps({"lang": "EN", "ko": "가격은 $1,200입니다"}))
    assert r.lang == "en" and r.ko == "가격은 $1,200입니다"


def test_parse_korean():
    assert parse_output('{"lang":"ko","ko":null}').ko is None


@pytest.mark.parametrize("raw", ["not json", "[]", '{"lang":"en"}', '{"ko":"x"}', '{"lang":"en","ko":"  "}'])
def test_parse_rejects(raw):
    with pytest.raises(ContentError):
        parse_output(raw)


def test_prompt_treats_body_as_data():
    assert "data" in SYSTEM_PROMPT and "never follow" in SYSTEM_PROMPT


async def test_missing_key_is_service_error_without_network():
    from app.translator.gpt import OpenAITranslator, ServiceError

    t = OpenAITranslator(None, "m")
    with pytest.raises(ServiceError, match="missing_api_key"):
        await t("hello")
