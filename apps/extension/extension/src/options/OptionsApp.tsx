import { useEffect, useState } from "react";
import PetFace from "../../../src/components/PetFace";
import {
  createMemory,
  MEMORY_KEY,
  reviveMemory,
  type PetMemory,
} from "../../../src/shared/pet/memory";
import { PERSONA } from "../../../src/shared/pet/persona";
import { getHealth } from "../../../src/shared/voice/relay";
import { dayKey } from "../../../src/shared/time/now";

// ============================================================================
// 확장 옵션 페이지.
//
// 시연 전에 손대야 하는 것만 둔다: Pet 의 이름과 호칭, 무대 모드, 기억 초기화·내보내기,
// 그리고 릴레이 상태. 온보딩 전체 플로우는 Phase B 로 미뤘다.
//
// 무대 모드가 여기 있는 이유: 발표장 네트워크를 믿을 수 없을 때 아예 시도하지 않게
// 하는 스위치다. 켜 두면 구워 둔 음성 → 무음 으로만 간다.
// ============================================================================

const STAGE_MODE_KEY = "memflix.pet.stageMode";

export default function OptionsApp() {
  const [memory, setMemory] = useState<PetMemory | null>(null);
  const [stageMode, setStageMode] = useState(false);
  const [health, setHealth] = useState<string>("확인 전");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void chrome.storage.local.get([MEMORY_KEY, STAGE_MODE_KEY]).then((bag) => {
      setMemory(reviveMemory(bag[MEMORY_KEY]));
      setStageMode(Boolean(bag[STAGE_MODE_KEY]));
    });
  }, []);

  function patch(next: Partial<PetMemory>): void {
    setMemory((prev) => {
      if (!prev) return prev;
      const merged = { ...prev, ...next };
      void chrome.storage.local.set({ [MEMORY_KEY]: merged });
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
      return merged;
    });
  }

  async function toggleStage(): Promise<void> {
    const next = !stageMode;
    setStageMode(next);
    await chrome.storage.local.set({ [STAGE_MODE_KEY]: next });
  }

  async function checkHealth(): Promise<void> {
    setHealth("확인 중…");
    const r = await getHealth();
    setHealth(
      r.ok ? `TTS ${r.value.tts ? "정상" : "실패"} · 얼굴 ${r.value.face ? "정상" : "실패"}` : `연결 실패 (${r.reason})`,
    );
  }

  function exportMemory(): void {
    if (!memory) return;
    const blob = new Blob([JSON.stringify(memory, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pet-memory-${dayKey()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function resetMemory(): void {
    const fresh = createMemory();
    void chrome.storage.local.set({ [MEMORY_KEY]: fresh });
    // 진행 기록도 함께 지운다 — 리허설을 처음부터 다시 하려는 것이므로
    void chrome.storage.session.clear();
    setMemory(fresh);
  }

  if (!memory) return <div className="opt-root">불러오는 중…</div>;

  return (
    <div className="opt-root">
      <style>{STYLES}</style>

      <header className="opt-head">
        <PetFace petName={memory.petName} size={72} />
        <div>
          <h1>{memory.petName} 설정</h1>
          <p>시연 전에 확인할 것들이에요.</p>
        </div>
      </header>

      <section className="opt-section">
        <h2>이름과 호칭</h2>
        <label>
          <span>Pet 이름</span>
          <input
            value={memory.petName}
            onChange={(e) => patch({ petName: e.target.value || PERSONA.defaultPetName })}
          />
        </label>
        <label>
          <span>나를 부르는 말</span>
          <input
            value={memory.userHonorific}
            onChange={(e) => patch({ userHonorific: e.target.value || PERSONA.defaultHonorific })}
          />
        </label>
        {saved && <div className="opt-saved">저장했어요</div>}
      </section>

      <section className="opt-section">
        <h2>무대 모드</h2>
        <p className="opt-desc">
          켜면 네트워크를 아예 시도하지 않아요. 미리 구워 둔 음성만 쓰고, 없으면 글자로만 말해요.
          발표장 네트워크를 믿을 수 없을 때 켜세요.
        </p>
        <button type="button" className={stageMode ? "opt-toggle on" : "opt-toggle"} onClick={toggleStage}>
          {stageMode ? "무대 모드 켜짐" : "무대 모드 꺼짐"}
        </button>
      </section>

      <section className="opt-section">
        <h2>릴레이 상태</h2>
        <p className="opt-desc">발표 30초 전 점검 항목이에요.</p>
        <div className="opt-row">
          <button type="button" onClick={checkHealth}>지금 확인</button>
          <span className="opt-health">{health}</span>
        </div>
      </section>

      <section className="opt-section">
        <h2>기억</h2>
        <p className="opt-desc">
          연속 {memory.streakDays}일째 · 남은 약속 {memory.openPromise ? "있음" : "없음"} ·
          모아둔 순간 {memory.moments.length}개
        </p>
        <div className="opt-row">
          <button type="button" onClick={exportMemory}>내보내기</button>
          <button type="button" className="opt-danger" onClick={resetMemory}>처음부터 다시</button>
        </div>
      </section>
    </div>
  );
}

const STYLES = `
.opt-root {
  max-width: 560px;
  margin: 0 auto;
  padding: 32px 24px 48px;
  color: #f1eefb;
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, "Malgun Gothic", sans-serif;
}
.opt-head { display: flex; align-items: center; gap: 16px; margin-bottom: 28px; }
.opt-head h1 { margin: 0 0 4px; font-size: 20px; font-weight: 800; }
.opt-head p { margin: 0; font-size: 13px; color: #8f87a3; }
.opt-section {
  padding: 18px 20px;
  margin-bottom: 16px;
  border-radius: 12px;
  border: 1px solid #2c2638;
  background: #191622;
}
.opt-section h2 { margin: 0 0 10px; font-size: 14px; font-weight: 800; color: #c4b5fd; }
.opt-desc { margin: 0 0 12px; font-size: 12.5px; line-height: 1.7; color: #8f87a3; word-break: keep-all; }
.opt-section label { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; font-size: 13.5px; }
.opt-section label span { flex: 0 0 110px; color: #b9b1cc; }
.opt-section input {
  flex: 1; min-width: 0;
  background: #221e2e; border: 1px solid #332c42; border-radius: 8px;
  color: #f1eefb; padding: 9px 12px; font-size: 14px; font-family: inherit;
}
.opt-section input:focus { outline: none; border-color: #8b5cf6; }
.opt-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.opt-section button {
  border: 1px solid #332c42; background: #221e2e; color: #ddd;
  border-radius: 8px; padding: 9px 16px; font-size: 13px; cursor: pointer; font-family: inherit;
}
.opt-section button:hover { border-color: #8b5cf6; color: #c4b5fd; }
.opt-toggle.on { border-color: #8b5cf6; background: rgba(139,92,246,0.18); color: #c4b5fd; font-weight: 700; }
.opt-danger:hover { border-color: #ef4444; color: #fca5a5; }
.opt-health { font-size: 12.5px; color: #8f87a3; }
.opt-saved { font-size: 12px; color: #4ade80; margin-top: 6px; }
`;
