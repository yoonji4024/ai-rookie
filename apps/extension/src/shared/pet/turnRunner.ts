// ============================================================================
// 한 비트(연속된 턴 묶음)를 진행하는 상태기계 — React 밖에 산다.
//
// 왜 React 밖인가. 예전 구현(ChatbotPanel.tsx 의 useEffect)은 콜백 4중 중첩이었고,
// deps 가 [questionIndex] 뿐이라 질문 세트를 갈아끼워도 반영되지 않았으며,
// onAllDone 이 stale closure 로 캡처됐다. 그 결함들은 상태기계를 이펙트 밖으로
// 꺼내는 순간 구조적으로 사라진다. 덤으로 node --test 로 테스트할 수 있게 된다.
//
// 계약 세 가지:
//   1. onDone 은 정확히 한 번 불린다 — 중복도 누락도 없다.
//   2. 어떤 턴도 무기한 기다리지 않는다. 모든 대기는 예산 시한을 통과한다.
//   3. abort() 는 언제 불려도 안전하고, 반드시 onDone({status:"aborted"}) 로 끝난다.
// ============================================================================

import type { BeatAbortReason, BeatOutcome, PetBeat, PetTurn } from "./types.ts";
import type { SpeakFn, SpeechRequest, SpeechResult } from "../voice/speak.ts";
import { log } from "../obs/log.ts";
import { withDeadline, delay } from "../obs/deadline.ts";

/** Pet 이 지금 무엇을 하고 있는가 — 얼굴과 UI 가 따라간다 */
export type PetPhase =
  | "watching"  // 같이 보는 중 (기본)
  | "speaking"  // Pet 이 말하는 중
  | "earsUp"    // 사용자 말을 듣는 중
  | "thinking"  // 답을 헤아리는 중
  | "resting";  // 턴 사이 쉼

export interface PetBubble {
  id: string;
  speaker: "pet" | "user";
  kind: PetTurn["kind"] | "answer";
  text: string;
}

/** 답변 획득 — Phase A 는 시뮬레이션, Phase B 는 실제 ASR 이 이 자리에 들어온다 */
export type AnswerFn = (turn: PetTurn, signal: AbortSignal) => Promise<string>;

export interface TurnRunnerDeps {
  beat: PetBeat;
  speak: SpeakFn;
  /** Pet 목소리 ID */
  petVoiceId: string;
  /** Phase A 의 사용자 대역 낭독 목소리 ID. 없으면 낭독을 건너뛴다 */
  simulatedUserVoiceId?: string;
  answer: AnswerFn;
  onBubble: (bubble: PetBubble) => void;
  onBubbleText: (bubbleId: string, text: string) => void;
  onPhase: (phase: PetPhase) => void;
  /** 정확히 한 번만 불린다 */
  onDone: (outcome: BeatOutcome) => void;
  /**
   * 턴 하나의 상한(ms). 기본은 글자당 260ms + 6초.
   * 260 은 기존 구현이 실측해 둔 한국어 TTS 의 글자당 상한이다.
   */
  budgetMs?: (text: string) => number;
}

export interface TurnRunnerApi {
  run(): void;
  abort(reason: BeatAbortReason): void;
}

const DEFAULT_REST_MS = 1000;
const ANSWER_BUDGET_MS = 15_000;

function defaultBudget(text: string): number {
  return Math.max(1, text.length) * 260 + 6000;
}

let bubbleSeq = 0;
function nextBubbleId(): string {
  bubbleSeq += 1;
  return `bubble-${bubbleSeq}`;
}

export function createTurnRunner(deps: TurnRunnerDeps): TurnRunnerApi {
  const budget = deps.budgetMs ?? defaultBudget;
  const controller = new AbortController();

  let started = false;
  let settled = false;
  let abortReason: BeatAbortReason | null = null;
  let activeStop: (() => void) | null = null;

  /** onDone 을 정확히 한 번만 통과시키는 문 */
  function settle(outcome: BeatOutcome): void {
    if (settled) return;
    settled = true;
    log.info("beat:done", { beat: deps.beat.id, status: outcome.status });
    deps.onDone(outcome);
  }

  /** Pet 이 한 문장 말한다. 말풍선을 먼저 띄우고 음성 길이에 맞춰 글자를 채운다 */
  async function speakLine(turn: PetTurn): Promise<SpeechResult> {
    const id = nextBubbleId();
    deps.onBubble({ id, speaker: "pet", kind: turn.kind, text: "" });
    deps.onPhase("speaking");

    const req: SpeechRequest = {
      text: turn.text,
      voiceId: deps.petVoiceId,
      emotion: turn.emotion,
      withFace: true,
      onReveal: (n) => deps.onBubbleText(id, turn.text.slice(0, n)),
    };
    const handle = deps.speak(req);
    activeStop = handle.stop;

    // speak() 의 done 은 계약상 반드시 settle 되지만, 구현이 바뀌어도 대화가 멈추지 않도록
    // 한 겹 더 감싼다. 여기가 "무기한 대기 금지" 규칙의 집행 지점이다.
    const result = await withDeadline(handle.done, budget(turn.text), `speak:${turn.id}`, () => {
      handle.stop();
      return { tier: "silent" as const, reason: "deadline" as const, durationMs: budget(turn.text) };
    });

    activeStop = null;
    deps.onBubbleText(id, turn.text); // 어떤 종료 사유든 문장은 끝까지 보여준다
    return result;
  }

  /** 사용자 대역 답변을 소리로 들려준다 (Phase A 데모 연출). 실패해도 흐름은 계속된다 */
  async function readSimulatedAnswer(turn: PetTurn): Promise<void> {
    if (!deps.simulatedUserVoiceId || !turn.simulatedAnswer) return;
    const handle = deps.speak({
      text: turn.simulatedAnswer,
      voiceId: deps.simulatedUserVoiceId,
      // 사용자가 말하는 동안 Pet 이 입을 뻥긋하면 누가 말하는지 알 수 없다
      withFace: false,
      onReveal: () => {},
    });
    activeStop = handle.stop;
    await withDeadline(handle.done, budget(turn.simulatedAnswer), `answerVoice:${turn.id}`, () => {
      handle.stop();
      return { tier: "silent" as const, reason: "deadline" as const, durationMs: 0 };
    });
    activeStop = null;
  }

  async function runTurn(turn: PetTurn, answers: Record<string, string>, degraded: Set<string>): Promise<void> {
    log.debug("turn:start", { beat: deps.beat.id, turn: turn.id, kind: turn.kind });

    const result = await speakLine(turn);
    if (result.reason === "blocked") degraded.add("voice-blocked");
    if (result.reason === "deadline") degraded.add("deadline");
    if (result.reason === "error") degraded.add("voice-offline");
    if (controller.signal.aborted) return;

    if (turn.kind === "ask") {
      deps.onPhase("earsUp");
      await readSimulatedAnswer(turn);
      if (controller.signal.aborted) return;

      deps.onPhase("thinking");
      const text = await withDeadline(
        deps.answer(turn, controller.signal),
        ANSWER_BUDGET_MS,
        `answer:${turn.id}`,
        () => turn.simulatedAnswer ?? "",
      );
      if (controller.signal.aborted) return;

      if (text) {
        answers[turn.id] = text;
        deps.onBubble({ id: nextBubbleId(), speaker: "user", kind: "answer", text });
      }

      if (turn.ack) {
        await runTurn(
          { id: `${turn.id}-ack`, kind: "remark", text: turn.ack, emotion: turn.emotion },
          answers,
          degraded,
        );
        return; // ack 이 자기 쉼을 가져간다
      }
    }

    deps.onPhase("resting");
    await delay(turn.restMs ?? DEFAULT_REST_MS, controller.signal);
    log.debug("turn:end", { beat: deps.beat.id, turn: turn.id });
  }

  return {
    run(): void {
      if (started) {
        log.warn("beat:double-run", { beat: deps.beat.id });
        return;
      }
      started = true;
      log.info("beat:start", { beat: deps.beat.id, turns: deps.beat.turns.length });

      const answers: Record<string, string> = {};
      const degraded = new Set<string>();

      void (async () => {
        try {
          for (const turn of deps.beat.turns) {
            if (controller.signal.aborted) break;
            await runTurn(turn, answers, degraded);
          }
        } catch (err) {
          // 어떤 예외도 대화를 영구 정지시키지 못한다
          log.error("beat:threw", { beat: deps.beat.id, message: String(err) });
          degraded.add("deadline");
        } finally {
          deps.onPhase("watching");
          if (abortReason) {
            settle({ status: "aborted", reason: abortReason });
          } else if (degraded.size > 0) {
            const reason = degraded.has("voice-blocked")
              ? "voice-blocked"
              : degraded.has("voice-offline")
                ? "voice-offline"
                : "deadline";
            settle({ status: "degraded", reason, answers });
          } else {
            settle({ status: "completed", answers });
          }
        }
      })();
    },

    abort(reason: BeatAbortReason): void {
      if (settled) return;
      abortReason = reason;
      log.info("beat:abort", { beat: deps.beat.id, reason });
      controller.abort();
      activeStop?.();
      activeStop = null;
      // run() 하기 전에 abort 될 수도 있다 — 그때는 여기서 끝낸다
      if (!started) settle({ status: "aborted", reason });
    },
  };
}
