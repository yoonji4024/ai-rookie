// Keep bootstrap independent from React and Chrome APIs. An app module failure
// must leave a readable error rather than an empty, hidden iframe.
const root=document.getElementById('root')!;
root.innerHTML='<p style="padding:20px;font:16px/1.6 sans-serif;color:#38292b;background:#fffcf8;border-radius:18px">두리 화면을 준비하고 있어요…</p>';
function failed(){
  root.innerHTML='<section role="alert" style="padding:20px;font:16px/1.6 sans-serif;color:#38292b;background:#fffcf8;border-radius:18px"><strong>두리 화면을 열지 못했어요.</strong><p>로그인과 별개로 화면을 시작하는 중 문제가 생겼어요.</p><button type="button" style="padding:12px;font:inherit">두리 다시 연결</button><p>오류 코드: 화면 시작 실패</p></section>';
  root.querySelector('button')!.addEventListener('click',()=>location.reload());
}
void import('./mount').then(module=>module.mount(root)).catch(failed);
