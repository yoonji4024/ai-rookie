export interface LiveTranscriptSession {
  send: (pcm16: ArrayBuffer) => void;
  finish: () => Promise<string>;
  cancel: () => void;
}

function liveTranscriptUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/api/score/stt/live`;
}

/**
 * 녹음과 동시에 A.X STT로 PCM을 보내 답변 종료 뒤의 전사 대기를 없앤다.
 * 연결이 실패하면 호출부가 기존 파일 전사로 폴백하며, API 키는 백엔드에만 있다.
 */
export function startLiveTranscript(
  answerKeywords: string[] = [],
  connectTimeoutMs = 1500,
): Promise<LiveTranscriptSession> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(liveTranscriptUrl());
    socket.binaryType = "arraybuffer";
    let settled = false;
    let finished = false;
    let finalSettled = false;
    let resolveFinal: ((text: string) => void) | null = null;
    let rejectFinal: ((reason: Error) => void) | null = null;
    const finalText = new Promise<string>((finalResolve, finalReject) => {
      resolveFinal = finalResolve;
      rejectFinal = finalReject;
    });
    const timeout = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(new Error("A.X 실시간 전사 연결 시간이 초과됐습니다."));
    }, connectTimeoutMs);

    socket.onopen = () => {
      socket.send(JSON.stringify({ type: "start", keywords: answerKeywords }));
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as {
        type?: string;
        text?: string;
        message?: string;
      };
      if (message.type === "ready" && !settled) {
        settled = true;
        window.clearTimeout(timeout);
        resolve({
          send: (pcm16) => {
            if (socket.readyState === WebSocket.OPEN && !finished) socket.send(pcm16);
          },
          finish: () => {
            if (!finished && socket.readyState === WebSocket.OPEN) {
              finished = true;
              socket.send(JSON.stringify({ type: "stop" }));
            } else if (!finished) {
              finished = true;
              finalSettled = true;
              rejectFinal?.(new Error("A.X 실시간 전사 연결이 이미 종료됐습니다."));
            }
            return finalText;
          },
          cancel: () => {
            finished = true;
            finalSettled = true;
            rejectFinal?.(new Error("실시간 전사가 취소됐습니다."));
            socket.close();
          },
        });
        return;
      }
      if (message.type === "done") {
        const text = message.text?.trim() ?? "";
        finalSettled = true;
        if (text) resolveFinal?.(text);
        else rejectFinal?.(new Error("A.X 실시간 전사 결과가 비어 있습니다."));
        socket.close();
      } else if (message.type === "error") {
        finalSettled = true;
        rejectFinal?.(new Error(message.message ?? "A.X 실시간 전사에 실패했습니다."));
        socket.close();
      }
    };
    socket.onerror = () => {
      const error = new Error("A.X 실시간 전사 연결에 실패했습니다.");
      if (!settled) {
        settled = true;
        window.clearTimeout(timeout);
        reject(error);
      } else {
        rejectFinal?.(error);
      }
    };
    socket.onclose = () => {
      if (!settled) {
        settled = true;
        window.clearTimeout(timeout);
        reject(new Error("A.X 실시간 전사 연결이 종료됐습니다."));
      } else if (!finalSettled) {
        finalSettled = true;
        rejectFinal?.(new Error("A.X 실시간 전사 연결이 종료됐습니다."));
      }
    };
  });
}
