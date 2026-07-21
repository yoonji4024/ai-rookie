# GPU Live 서버 연결 & 실험 시작 가이드

VSCode Remote-SSH로 GPU Live 워크로드에 붙어 Kang 베이스라인을 재현하는 절차.

---

## 0. 사전: 로컬 레포를 git 원격에 올리기 (최초 1회)

서버에서 `git clone` 하려면 원격 저장소(GitHub/GitLab 등)가 필요하다.
> ⚠️ 이 폴더의 `.git`은 Claude가 만들다 락파일 권한 문제로 중단됐다. **네 컴퓨터 터미널에서** 아래로 정리 후 진행:

```bash
cd ~/Desktop/SLPR/ai-rookie
rm -f .git/index.lock          # 남아있는 락 제거 (네 계정은 권한 있음)
git add -A
git commit -m "프로젝트 피벗 + Kang 베이스라인"
# 팀 원격 저장소 만들고(예: GitHub private) 연결:
git remote add origin <REMOTE_URL>
git push -u origin master
```

`.gitignore`가 `.env`·`data/Kang`·`*.wav`·`*.pem`·모델산출물을 이미 차단한다 → **키·실데이터는 절대 안 올라간다.**

---

## 1. VSCode Remote-SSH 연결

1. VSCode에 **Remote - SSH** 확장 설치 (Microsoft).
2. GPU Live 콘솔 → 워크로드 → 인스턴스 상세에서 받은 **PEM 키**를 `~/.ssh/gpulive.pem` 로 저장하고 권한 조정:
   ```bash
   chmod 600 ~/.ssh/gpulive.pem
   ```
3. `~/.ssh/config` 에 아래 블록 추가 (host/port는 콘솔의 SSH 명령어에서 복사):
   ```
   Host gpulive
       HostName proxy-app.<도메인>
       Port <포트번호>
       User ubuntu
       IdentityFile ~/.ssh/gpulive.pem
       StrictHostKeyChecking no
   ```
4. VSCode 명령팔레트(⌘⇧P) → **Remote-SSH: Connect to Host** → `gpulive` 선택.
5. 연결되면 폴더 열기 → 작업 디렉토리(`/home/ubuntu/workspace` 등) 선택.

---

## 2. 서버에서 코드·데이터 배치

VSCode 통합 터미널(= 서버 셸)에서:

```bash
# 코드
git clone <REMOTE_URL> ai-rookie
cd ai-rookie
```

### ⚠️ `.env`(API 키)는 git에 없다 — 반드시 별도 전송

`.gitignore`가 키를 막으므로 서버에 자동으로 가지 않는다. **키를 추가·변경할 때마다** 다시 보내야 한다.

```bash
# (Mac에서)
scp ~/Desktop/SLPR/ai-rookie/.env gpulive:~/data/ai-rookie/.env
```

확인:
```bash
# (서버에서)
grep -c API_KEY ~/data/ai-rookie/.env      # 키 개수 확인
python3 -m src.common.llm                  # LLM 4종 연결 점검
```

> 실제로 겪은 문제: VARCO 키를 나중에 추가했는데 서버 `.env`가 옛 버전이라
> TTS가 조용히 `NullTTS`로 폴백됐다. 키 추가 시 이 단계를 잊지 말 것.

### Kang 데이터

**Kang 데이터(2GB)는 git에 없다** → 스토리지에 별도 업로드:
- 콘솔 → 스토리지 상세 → **Web SFTP 연결** (또는 FileZilla, SSH와 동일 접속정보)
- `data/Kang/{HC,MCI}/` 구조 그대로 업로드
- ⚠️ **반드시 마운트한 스토리지(BOUND) 경로에** 둔다. 워크로드 볼륨은 종료 시 삭제될 수 있음.

---

## 3. 환경 세팅 & 베이스라인 재현

```bash
bash setup_server.sh          # venv + 패키지 설치 + import 검증 + 데이터 확인
source .venv/bin/activate
rm -f data/kang_features.npz
python -m src.agents.analysis.run_kang_baseline
```

기대: `MCI AUC ≈ 0.83~0.88 (KPI ≥0.74 PASS)`.
로컬과 달리 서버에선 **kiwipiepy(형태소)·parselmouth(F0/jitter/shimmer)가 정식 동작** → 언어/음향 피처가 fallback이 아닌 실제값 → 숫자가 달라질 수 있고, 이게 진짜 베이스라인이다.

---

## 4. 실험 시작 시 주의 (CLAUDE.md §11)

- **결과·체크포인트는 마운트 스토리지에 저장.** 워크로드 볼륨은 종료 시 소실.
- **유휴 GPU 자동 회수** — 방치하면 워크로드 회수될 수 있음. 체크포인트 자주 저장.
- 무거운 실험(MLP·튜닝)은 서버, 골격 수정은 로컬 → git으로 동기화.

---

## 5. 다음 실험 (PLAN.md NOW/BACKLOG)

1. kiwi·praat 정식 설치 후 **베이스라인 재측정** (진짜 피처).
2. **발화량 교란 점검**: 발화당 정규화 피처(형태소/발화, 속도)로 재실험 — 현재 상위피처가 "말 많이 함"에 치우침.
3. **pause 재설계**: 발화 간 휴지 포착하도록 오디오 세그멘테이션 개선.
4. MLP 실험 + 음향/언어/결합 ablation.
