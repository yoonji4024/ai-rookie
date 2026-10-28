import {Component,type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import ConnectedPetApp from './ConnectedPetApp';

class StartupBoundary extends Component<{children:ReactNode},{failed:boolean}>{
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){
    return this.state.failed?<section role="alert" style={{padding:20,background:'#fdfdfd',borderRadius:18}}>
      <h2>두리 화면을 시작하지 못했어요.</h2>
      <p>확장을 갱신했다면 영상 탭도 다시 열어 주세요.</p>
      <button onClick={()=>location.reload()}>두리 다시 연결</button>
      <p>오류 코드: 화면 연결 초기화</p>
    </section>:this.props.children;
  }
}
export function mount(root:HTMLElement){
  createRoot(root).render(<StartupBoundary><ConnectedPetApp/></StartupBoundary>);
}
