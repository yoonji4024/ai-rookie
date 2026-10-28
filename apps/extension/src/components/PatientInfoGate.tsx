import { useState, type FormEvent } from "react";
import ChatbotPanel from "./ChatbotPanel";
import { ORIENTATION_QUESTIONS } from "../lib/orientationQuestions";
import { PERSONA } from "../shared/pet/persona";

// ============================================================================
// 로그인 게이트
// 사용유형(보호자/사용자)을 선택하고 아이디·비밀번호로 로그인한다.
// 실제 서비스에서는 서버 인증으로 대체된다.
// "일반 사용자"를 선택하면 우하단에 Pet 챗봇이 떠서 지남력(시간·장소·
// 사람)을 가늠할 수 있는 질문을 일상 대화처럼 건넨다. 보호자에게는 띄우지
// 않고, 역할 선택 클릭 직후라 소리 있는 자동 재생이 허용된다.
// 주의: 사용자에게 보이는 화면이므로 측정 목적(치매/인지/검사 등)을 드러내는
// 문구를 절대 노출하지 않는다.
// 질문 데이터는 보호자 리포트와 공유하는 src/lib/orientationQuestions.ts에 있다.
// ============================================================================

export type UserRole = "guardian" | "user";

export interface LoginInfo {
  role: UserRole;
  username: string;
  password: string;
}

export interface PatientInfoGateProps {
  onComplete: (info: LoginInfo) => void;
}

export default function PatientInfoGate({ onComplete }: PatientInfoGateProps) {
  const [role, setRole] = useState<UserRole | "">("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!role) {
      setError("이용 유형(일반 사용자/패밀리 사용자)을 선택해 주세요.");
      return;
    }
    const trimmedUsername = username.trim();
    if (trimmedUsername.length < 2) {
      setError("아이디를 2자 이상 입력해 주세요.");
      return;
    }
    if (password.length < 4) {
      setError("비밀번호를 4자 이상 입력해 주세요.");
      return;
    }
    onComplete({ role, username: trimmedUsername, password });
  };

  return (
    <div className="pig-root">
      <style>{STYLES}</style>

      <form className="pig-card" onSubmit={handleSubmit} noValidate>
        {/* Netflix 오마주 워드마크: memory + flix */}
        <div className="pig-logo" aria-label="MEMFLIX">
          MEMFLIX
        </div>
        <h1 className="pig-title">로그인</h1>
        <p className="pig-desc">
          이용 유형을 선택하고 로그인해 주세요.
        </p>

        <div className="pig-gender-row">
          {(
            [
              ["guardian", "패밀리 사용자"],
              ["user", "일반 사용자"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`pig-gender-btn${role === value ? " pig-gender-on" : ""}`}
              onClick={() => setRole(role === value ? "" : value)}
            >
              {label}
            </button>
          ))}
        </div>

        <input
          id="pig-username"
          className="pig-input"
          type="text"
          placeholder="아이디를 입력하세요"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
        />

        <input
          id="pig-password"
          className="pig-input"
          type="password"
          placeholder="비밀번호를 입력하세요"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />

        {error && <div className="pig-error">⚠ {error}</div>}

        <button className="pig-submit" type="submit">
          로그인
        </button>
        <div className="pig-foot">입력한 정보는 로그인 확인에만 사용돼요.</div>
      </form>

      {/* 일반 사용자를 선택한 동안에만 표시. 역할 변경/로그인 시 언마운트되며 음성도 중단된다 */}
      {role === "user" && (
        <div className="pig-chatbot-dock">
          <ChatbotPanel questions={ORIENTATION_QUESTIONS} title={PERSONA.defaultPetName} startDelayMs={600} />
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 스타일 (블랙 배경 + 퍼플 포인트, 리포트와 동일 톤)
// ============================================================================
const STYLES = `
.pig-root {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  box-sizing: border-box;
  background: radial-gradient(ellipse at 50% 0%, #160b2d 0%, #000 65%);
  color: #fff;
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, "Malgun Gothic", sans-serif;
  color-scheme: dark;
}
.pig-card {
  width: min(430px, 94vw);
  max-height: 94vh;
  overflow-y: auto;
  background: #141414;
  border: 1px solid #2a2a2a;
  border-radius: 18px;
  padding: 34px 36px 26px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
}
/* Netflix 오마주 워드마크: 테마 보라 그라데이션(밝은 위 → 짙은 아래)으로
   넷플릭스 로고 특유의 입체감을 내고, 전체적으로는 더 어둡게 눌러준다 */
.pig-logo {
  text-align: center;
  margin: 4px 0 22px;
  font-family: "Arial Black", "Avenir Next Condensed", "Helvetica Neue", sans-serif;
  font-size: 38px;
  font-weight: 900;
  letter-spacing: 0.01em;
  line-height: 1;
  color: #5b21b6;
  background: linear-gradient(to bottom, #a78bfa 0%, #7c3aed 45%, #4c1d95 100%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  transform: scaleY(1.18);
  transform-origin: center;
  filter: drop-shadow(0 8px 20px rgba(76, 29, 149, 0.5));
  user-select: none;
}
.pig-title {
  margin: 0 0 10px;
  font-size: 24px;
  font-weight: 800;
  text-align: center;
}
.pig-desc {
  margin: 0 0 24px;
  color: #999;
  font-size: 13.5px;
  line-height: 1.7;
  text-align: center;
  word-break: keep-all;
}
.pig-desc b {
  color: #c4b5fd;
}

.pig-input {
  width: 100%;
  box-sizing: border-box;
  background: #1b1b1b;
  border: 1px solid #333;
  border-radius: 10px;
  color: #fff;
  font-size: 15px;
  padding: 12px 14px;
  margin-bottom: 18px;
  outline: none;
  transition: border-color 0.15s ease;
  font-family: inherit;
}
.pig-input:focus {
  border-color: #8b5cf6;
}
.pig-input::placeholder {
  color: #555;
}

.pig-gender-row {
  display: flex;
  gap: 10px;
  margin-bottom: 18px;
}
.pig-gender-btn {
  flex: 1;
  padding: 11px 0;
  border-radius: 10px;
  border: 1px solid #333;
  background: #1b1b1b;
  color: #bbb;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
}
.pig-gender-btn:hover {
  border-color: #555;
}
.pig-gender-on {
  border-color: #8b5cf6;
  background: rgba(139, 92, 246, 0.16);
  color: #c4b5fd;
}

.pig-error {
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(239, 68, 68, 0.4);
  color: #fca5a5;
  border-radius: 10px;
  font-size: 13px;
  padding: 10px 14px;
  margin-bottom: 16px;
}

.pig-submit {
  width: 100%;
  padding: 14px 0;
  border: none;
  border-radius: 12px;
  background: #8b5cf6;
  color: #fff;
  font-size: 15.5px;
  font-weight: 800;
  cursor: pointer;
  transition: background 0.15s ease, transform 0.15s ease;
}
.pig-submit:hover {
  background: #a78bfa;
  transform: translateY(-1px);
}
.pig-foot {
  margin-top: 14px;
  text-align: center;
  color: #666;
  font-size: 11.5px;
}

/* 로그인 카드를 가리지 않는 우하단 플로팅 도크 — 로그인은 항상 비차단 */
.pig-chatbot-dock {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 50;
}
`;
