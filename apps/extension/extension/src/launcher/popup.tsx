import {createRoot} from 'react-dom/client';
import Launcher from './Launcher';
import {openOnTab} from './openOnTab';
document.documentElement.classList.add('toolbar-popup');
createRoot(document.getElementById('root')!).render(<Launcher/>);
// On supported pages show the in-page companion; otherwise keep the small launcher.
void openOnTab(chrome.tabs).then(opened=>{if(opened)window.close();});
