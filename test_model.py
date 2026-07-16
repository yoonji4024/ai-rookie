"""
대회 제공 LLM API 연결 테스트.
사용법:
  python test_models.py          # 전체 모델 한 번에 테스트
  python test_models.py ax       # SKT A.X K1만
  python test_models.py exaone   # LG EXAONE만
  python test_models.py midm     # KT 믿:음만
  python test_models.py solar    # Upstage Solar Pro 2만
"""
import os
import sys
from dotenv import load_dotenv
from openai import OpenAI

load_dotenv()

PROMPT = [{"role": "user", "content": "안녕! 한 줄로 자기소개 해줘."}]


def make_client(api_key, base_url):
    return OpenAI(api_key=os.environ[api_key], base_url=base_url)


def test_ax():
    client = make_client("AX_API_KEY", "https://awf-gw.adot.ai/v1")
    resp = client.chat.completions.create(model="A.X-K1", messages=PROMPT)
    return resp.choices[0].message.content


def test_exaone():
    client = make_client("EXAONE_API_KEY", "https://api.friendli.ai/dedicated/v1")
    resp = client.chat.completions.create(
        model=os.environ["EXAONE_ENDPOINT_ID"], messages=PROMPT
    )
    return resp.choices[0].message.content


def test_midm():
    base = os.environ["MIDM_ENDPOINT_URL"].replace("/chat/completions", "")
    client = make_client("MIDM_API_KEY", base)
    resp = client.chat.completions.create(
        model=os.environ["MIDM_ENDPOINT_ID"], messages=PROMPT
    )
    return resp.choices[0].message.content


def test_solar():
    client = make_client("SOLAR_API_KEY", "https://api.upstage.ai/v1")
    resp = client.chat.completions.create(model="solar-pro2", messages=PROMPT)
    return resp.choices[0].message.content


TESTS = {
    "ax":     ("SKT A.X K1",          test_ax),
    "exaone": ("LG EXAONE",           test_exaone),
    "midm":   ("KT 믿:음 2.0",        test_midm),
    "solar":  ("Upstage Solar Pro 2", test_solar),
}


def run(key):
    label, fn = TESTS[key]
    try:
        out = fn()
        print(f"✅ {label}\n   {out}\n")
    except Exception as e:
        print(f"❌ {label}\n   {type(e).__name__}: {e}\n")


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    if arg:
        if arg not in TESTS:
            print(f"알 수 없는 모델: {arg}  (선택: {', '.join(TESTS)})")
            sys.exit(1)
        run(arg)
    else:
        for k in TESTS:
            run(k)