export const CONNECTION_MESSAGE='분석 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.';
export function transportError(error:unknown):Error {
  if(error instanceof Error&&error.name==='AbortError')return error;
  if(error instanceof Error&&error.name==='TimeoutError')return new Error('서버 응답이 늦어지고 있어요. 잠시 후 다시 확인해 주세요.');
  return new Error(CONNECTION_MESSAGE);
}
export function responseError(status:number,detail:unknown):Error {
  if([502,503,504].includes(status))return new Error(CONNECTION_MESSAGE);
  if(typeof detail==='string')return new Error(detail);
  return new Error(status===401?'다시 로그인해 주세요.':'요청을 처리하지 못했어요. 잠시 후 다시 확인해 주세요.');
}
